//! Original shell state. Open descriptors and filesystem objects live outside
//! this value: isolated shell environments copy rules/state, never byte streams.
use crate::{
    executor::Cancel,
    expand::{Error, Work},
};
use shell_parser::parser::Command;
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

pub type SharedState = Rc<RefCell<State>>;

#[derive(Clone, Debug)]
pub(crate) struct LocalVariable {
    previous: Option<String>,
    nameref: Option<String>,
    exported: bool,
    readonly: bool,
}

#[derive(Clone, Debug)]
pub struct State {
    pub shell_name: String,
    pub variables: BTreeMap<String, String>,
    pub exported: BTreeSet<String>,
    pub readonly: BTreeSet<String>,
    /// Scalar reference targets, distinct from ordinary variable values.
    pub(crate) namerefs: BTreeMap<String, String>,
    pub cwd: String,
    /// Function bodies are immutable. Isolated shells copy bindings, not ASTs.
    pub functions: BTreeMap<String, Rc<Command>>,
    pub status: i32,
    pub pipestatus: Vec<i32>,
    pub pipefail: bool,
    pub nounset: bool,
    /// Last published synthetic async handle. Isolated shells inherit a copy.
    pub(crate) last_async: Option<String>,
    pub(crate) positional: Vec<String>,
    pub(crate) locals: Vec<BTreeMap<String, LocalVariable>>,
    prefixes: Vec<BTreeMap<String, Option<String>>>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            shell_name: "bash".into(),
            variables: BTreeMap::from([("IFS".into(), " \t\n".into())]),
            exported: BTreeSet::new(),
            readonly: BTreeSet::new(),
            namerefs: BTreeMap::new(),
            cwd: "/home/guest".into(),
            functions: BTreeMap::new(),
            status: 0,
            pipestatus: vec![0],
            pipefail: false,
            nounset: false,
            last_async: None,
            positional: Vec::new(),
            locals: Vec::new(),
            prefixes: Vec::new(),
        }
    }
}
impl State {
    pub fn shared(self) -> SharedState {
        Rc::new(RefCell::new(self))
    }
    /// Copy an isolated shell's retained state against the command's shared
    /// storage/work limits. The calling shell must remain logically quiescent
    /// until this finishes, as it does while awaiting substitution expansion.
    /// No RefCell borrow crosses a checkpoint. Each individual copy is admitted
    /// before allocation and bounded by the remaining storage allowance; its
    /// bytes are then walked cooperatively, including bytes never emitted.
    ///
    /// Function payloads stay shared, so only their binding/name/node storage is
    /// copied and charged here. A caller that clones an AST for execution must
    /// separately admit and account for that clone. Charges remain with Work
    /// for the command's lifetime, even if a child finishes sooner.
    pub(crate) async fn snapshot(
        source: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Self, Error> {
        work.checkpoint(cancel).await?;
        // Include a future shared() allocation and its RefCell/Rc bookkeeping.
        work.admit_storage(
            std::mem::size_of::<RefCell<Self>>() + 2 * std::mem::size_of::<usize>(),
        )?;
        let shell_name = snapshot_value(source, |s| Some(&s.shell_name), cancel, work).await?;
        let cwd = snapshot_value(source, |s| Some(&s.cwd), cancel, work).await?;
        let variables = snapshot_map(source, |s| &s.variables, cancel, work).await?;
        let exported = snapshot_set(source, |s| &s.exported, cancel, work).await?;
        let readonly = snapshot_set(source, |s| &s.readonly, cancel, work).await?;
        let namerefs = snapshot_map(source, |s| &s.namerefs, cancel, work).await?;
        let functions = snapshot_map(source, |s| &s.functions, cancel, work).await?;
        let pipestatus = snapshot_vec(source, |s| &s.pipestatus, cancel, work).await?;
        let positional = snapshot_vec(source, |s| &s.positional, cancel, work).await?;
        let last_async = snapshot_value(source, |s| Some(&s.last_async), cancel, work).await?;
        let (local_count, prefix_count) = {
            let state = source.borrow();
            (state.locals.len(), state.prefixes.len())
        };
        let mut locals = snapshot_slots(local_count, work)?;
        for index in 0..local_count {
            locals.push(snapshot_map(source, |s| &s.locals[index], cancel, work).await?);
        }
        let mut prefixes = snapshot_slots(prefix_count, work)?;
        for index in 0..prefix_count {
            prefixes.push(snapshot_map(source, |s| &s.prefixes[index], cancel, work).await?);
        }
        let state = source.borrow();
        Ok(Self {
            shell_name,
            variables,
            exported,
            readonly,
            namerefs,
            cwd,
            functions,
            status: state.status,
            pipestatus,
            pipefail: state.pipefail,
            nounset: state.nounset,
            last_async,
            positional,
            locals,
            prefixes,
        })
    }
    pub(crate) fn parameter(&self, name: &str) -> Cow<'_, str> {
        match name {
            "0" => Cow::Borrowed(&self.shell_name),
            "?" => Cow::Owned(self.status.to_string()),
            "PWD" => Cow::Borrowed(&self.cwd),
            "#" => Cow::Owned(self.positional.len().to_string()),
            "!" => Cow::Borrowed(self.last_async.as_deref().unwrap_or("")),
            _ => name
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|n| self.positional.get(n))
                .map(String::as_str)
                .or_else(|| self.scalar_parameter(name))
                .map(Cow::Borrowed)
                .unwrap_or(Cow::Borrowed("")),
        }
    }
    pub(crate) fn scalar_parameter(&self, name: &str) -> Option<&str> {
        if name == "!" {
            return self.last_async.as_deref();
        }
        let name = self.scalar_target(name).ok().flatten()?;
        if name == "PWD" {
            return Some(&self.cwd);
        }
        self.variables.get(name).map(String::as_str)
    }
    /// Takes ownership of argv already admitted by command expansion.
    pub(crate) fn replace_positional(&mut self, args: Vec<String>) {
        self.positional = args;
    }
    pub(crate) fn is_nameref(&self, name: &str) -> bool {
        self.namerefs.contains_key(name)
    }
    pub(crate) fn shares_scalar_binding(&self, first: &str, second: &str) -> Result<bool, i32> {
        let Some(first) = self.scalar_target(first)? else {
            return Ok(false);
        };
        Ok(self.scalar_target(second)? == Some(first))
    }
    pub(crate) fn indirect_parameter<'a>(&'a self, name: &'a str) -> Result<Option<&'a str>, i32> {
        if self.is_nameref(name) {
            return self.scalar_target(name);
        }
        Ok(self.scalar_parameter(name))
    }
    /// Original bounded scalar adapter for Bashkit's resolve_nameref and
    /// resolve_nameref_strict (interpreter/mod.rs and declare.rs, 491c3281).
    /// A cycle has no scalar value. An acyclic chain beyond the bound fails.
    /// Floyd's cursor uses constant storage, including in recursive expansion.
    pub(crate) fn scalar_target<'a>(&'a self, name: &'a str) -> Result<Option<&'a str>, i32> {
        let mut current = name;
        let mut fast = Some(name);
        for _ in 0..64 {
            let Some(next) = self.namerefs.get(current) else {
                return Ok(Some(current));
            };
            current = next;
            fast = fast.and_then(|name| self.namerefs.get(name).map(String::as_str));
            fast = fast.and_then(|name| self.namerefs.get(name).map(String::as_str));
            if fast == Some(current) {
                return Ok(None);
            }
        }
        if self.namerefs.contains_key(current) {
            return Err(2);
        }
        Ok(Some(current))
    }
    /// Account for reference traversal without copying targets or holding a
    /// state borrow over a yield. Ordinary variables retain their prior cost.
    pub(crate) async fn admit_scalar_access(
        state: &SharedState,
        name: &str,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        if cancel.is_cancelled() {
            return Err(130.into());
        }
        let bytes = state.borrow().reference_work(name)?;
        snapshot_steps(bytes, cancel, work).await
    }
    fn reference_work(&self, name: &str) -> Result<usize, i32> {
        let mut current = name;
        let mut bytes = 0usize;
        for _ in 0..64 {
            let Some(next) = self.namerefs.get(current) else {
                return Ok(bytes);
            };
            // Includes the resolver's second cursor and name comparisons.
            bytes = bytes
                .checked_add(current.len().saturating_add(next.len()).saturating_mul(4))
                .ok_or(2)?;
            current = next;
        }
        self.scalar_target(name)?;
        Ok(bytes)
    }
    /// Call before a supported scalar write. In addition to the caller's RHS
    /// storage, aliases can require an owned target key and a saved prefix copy.
    pub(crate) async fn admit_assignment(
        state: &SharedState,
        name: &str,
        value_bytes: usize,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        Self::admit_scalar_access(state, name, cancel, work).await?;
        state
            .borrow()
            .admit_assignment_storage(name, value_bytes, work)
    }
    pub(crate) fn admit_assignment_storage(
        &self,
        name: &str,
        value_bytes: usize,
        work: &mut Work,
    ) -> Result<(), Error> {
        let Some(target) = self.scalar_target(name)? else {
            return Err(1.into());
        };
        if target == name {
            return Ok(());
        }
        // Covers both owned target keys in PrefixFrame::set as well as the
        // variable and saved-prefix B-tree insertions, before either grows.
        work.admit_storage(target.len().saturating_mul(2))?;
        work.admit_storage(snapshot_node_bytes::<Option<String>>()?)?;
        if !self.variables.contains_key(target) {
            work.admit_storage(snapshot_node_bytes::<String>()?)?;
        }
        if self.prefix_saved(target) {
            work.admit_storage(value_bytes)?;
        }
        Ok(())
    }
    pub(crate) fn prefix_saved(&self, name: &str) -> bool {
        self.prefixes
            .last()
            .is_some_and(|saved| saved.contains_key(name))
    }
    pub(crate) fn assign_parameter(&mut self, name: String, value: String) -> Result<(), i32> {
        let name = self.assignment_name(name)?;
        if self.is_readonly(&name) {
            return Err(1);
        }
        if let Some(saved) = self
            .prefixes
            .last_mut()
            .and_then(|frame| frame.get_mut(&name))
        {
            *saved = Some(value.clone());
        }
        self.variables.insert(name, value);
        Ok(())
    }
    fn assignment_name(&self, name: String) -> Result<String, i32> {
        let target = self.scalar_target(&name)?.ok_or(1)?;
        if target == name {
            return Ok(name);
        }
        Ok(target.to_owned())
    }
    pub(crate) fn is_readonly(&self, name: &str) -> bool {
        self.locals
            .iter()
            .rev()
            .find_map(|locals| locals.get(name))
            .map_or_else(|| self.readonly.contains(name), |local| local.readonly)
    }
    fn current_local_readonly(&self, name: &str) -> bool {
        self.locals
            .last()
            .and_then(|locals| locals.get(name))
            .is_some_and(|local| local.readonly)
    }
    pub(crate) fn readonly(&mut self, name: String, value: Option<String>) -> Result<(), i32> {
        let name = self.assignment_name(name)?;
        if let Some(value) = value {
            self.assign_parameter(name.clone(), value)?;
        }
        let owner = self
            .locals
            .iter_mut()
            .rev()
            .find_map(|locals| locals.get_mut(&name));
        if let Some(local) = owner {
            local.readonly = true;
            return Ok(());
        }
        self.readonly.insert(name);
        Ok(())
    }
    pub(crate) fn export(&mut self, name: String, value: Option<String>) -> Result<(), i32> {
        let name = self.assignment_name(name)?;
        if let Some(value) = value {
            self.assign_parameter(name.clone(), value)?;
        }
        self.exported.insert(name);
        Ok(())
    }
    /// Resolve attributes and values to one binding. Admit the retained set
    /// node and all temporary/assignment keys before copying the target name.
    pub(crate) async fn attribute_target(
        state: &SharedState,
        name: &str,
        readonly: bool,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<String, Error> {
        Self::admit_scalar_access(state, name, cancel, work).await?;
        let state = state.borrow();
        let target = state.scalar_target(name)?.ok_or(1)?;
        let present = if readonly {
            state.locals.iter().any(|frame| frame.contains_key(target))
                || state.readonly.contains(target)
        } else {
            state.exported.contains(target)
        };
        work.admit_storage(target.len().saturating_mul(3))?;
        if !present {
            work.admit_storage(snapshot_node_bytes::<()>()?)?;
        }
        Ok(target.to_owned())
    }
    pub(crate) fn environment(&self) -> BTreeMap<String, String> {
        self.exported
            .iter()
            .filter_map(|name| self.variables.get(name).map(|v| (name.clone(), v.clone())))
            .collect()
    }
    /// Unset a variable. A local declared in the current function stays
    /// local (and unset) until the function returns. A local declared by a
    /// calling function is removed from that frame instead, revealing the
    /// value it shadowed, as Bash's dynamic scoping does. Returns whether a
    /// variable existed; readonly variables are an error.
    pub(crate) fn unset_variable(&mut self, name: &str) -> Result<bool, ()> {
        if !self.namerefs.contains_key(name) {
            return self.unset_binding(name);
        }
        let name = self
            .scalar_target(name)
            .map_err(|_| ())?
            .ok_or(())?
            .to_owned();
        self.unset_binding(&name)
    }
    fn unset_binding(&mut self, name: &str) -> Result<bool, ()> {
        if self.is_readonly(name) {
            return Err(());
        }
        let frame = self
            .locals
            .iter()
            .rposition(|locals| locals.contains_key(name));
        if let Some(index) = frame
            && index + 1 != self.locals.len()
        {
            let local = self.locals[index].remove(name).ok_or(())?;
            restore_nameref(&mut self.namerefs, name, local.nameref);
            if local.exported {
                self.exported.insert(name.to_owned());
            } else {
                self.exported.remove(name);
            }
            let existed = self.variables.contains_key(name);
            match local.previous {
                Some(value) => self.variables.insert(name.to_owned(), value),
                None => self.variables.remove(name),
            };
            return Ok(existed);
        }
        if let Some(saved) = self
            .prefixes
            .last_mut()
            .and_then(|frame| frame.get_mut(name))
        {
            *saved = None;
        }
        self.exported.remove(name);
        Ok(self.variables.remove(name).is_some())
    }
    pub(crate) fn local(&mut self, name: String, value: String) -> Result<(), i32> {
        self.save_local(&name)?;
        self.namerefs.remove(&name);
        self.variables.insert(name, value);
        Ok(())
    }
    fn save_local(&mut self, name: &str) -> Result<(), i32> {
        if self.readonly.contains(name) || self.current_local_readonly(name) {
            return Err(1);
        }
        let frame = self.locals.last_mut().ok_or(1)?;
        if !frame.contains_key(name) {
            let previous = LocalVariable {
                previous: self.variables.remove(name),
                nameref: self.namerefs.remove(name),
                exported: self.exported.contains(name),
                readonly: false,
            };
            frame.insert(name.to_owned(), previous);
        }
        Ok(())
    }
    /// `declare -n` is local inside a function, like `local -n`. Only ordinary
    /// scalar targets are admitted by the declaration adapter.
    pub(crate) fn declare_nameref(
        &mut self,
        name: String,
        target: String,
        local: bool,
    ) -> Result<(), i32> {
        if self.readonly.contains(&name) || self.current_local_readonly(&name) {
            return Err(1);
        }
        if name == target && !local {
            return Err(1);
        }
        if local {
            self.save_local(&name)?;
        }
        self.variables.remove(&name);
        self.namerefs.insert(name, target);
        Ok(())
    }
    pub(crate) fn declaration_storage(&self, name: &str, local: bool) -> Result<usize, Error> {
        let mut bytes = snapshot_node_bytes::<String>()?.saturating_add(name.len());
        if !local
            || self
                .locals
                .last()
                .is_some_and(|frame| frame.contains_key(name))
        {
            return Ok(bytes);
        }
        bytes = bytes
            .saturating_add(snapshot_node_bytes::<LocalVariable>()?)
            .saturating_add(name.len())
            .saturating_add(self.variables.get(name).map_or(0, String::len))
            .saturating_add(self.namerefs.get(name).map_or(0, String::len));
        Ok(bytes)
    }
}

fn restore_nameref(namerefs: &mut BTreeMap<String, String>, name: &str, target: Option<String>) {
    match target {
        Some(target) => {
            namerefs.insert(name.to_owned(), target);
        }
        None => {
            namerefs.remove(name);
        }
    }
}

// These are the only values copied by the state snapshot. Keeping this list
// explicit prevents accidentally introducing a recursively cloned AST/value.
trait SnapshotValue: Clone {
    fn snapshot_bytes(&self) -> usize;
}
impl SnapshotValue for String {
    fn snapshot_bytes(&self) -> usize {
        self.len()
    }
}
impl SnapshotValue for Option<String> {
    fn snapshot_bytes(&self) -> usize {
        self.as_ref().map_or(0, String::len)
    }
}
impl SnapshotValue for LocalVariable {
    fn snapshot_bytes(&self) -> usize {
        self.previous
            .snapshot_bytes()
            .saturating_add(self.nameref.snapshot_bytes())
    }
}
impl SnapshotValue for Rc<Command> {
    fn snapshot_bytes(&self) -> usize {
        0
    }
}
impl SnapshotValue for i32 {
    fn snapshot_bytes(&self) -> usize {
        0
    }
}

async fn snapshot_steps(bytes: usize, cancel: &Cancel, work: &mut Work) -> Result<(), Error> {
    for _ in 0..bytes {
        work.checkpoint(cancel).await?;
    }
    Ok(())
}

async fn snapshot_value<T: SnapshotValue>(
    source: &SharedState,
    select: impl Fn(&State) -> Option<&T>,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<T, Error> {
    work.checkpoint(cancel).await?;
    let (value, bytes) = {
        let state = source.borrow();
        let value = select(&state).ok_or(2)?;
        let bytes = value.snapshot_bytes();
        work.admit_storage(bytes)?;
        (value.clone(), bytes)
    };
    snapshot_steps(bytes, cancel, work).await?;
    Ok(value)
}

fn snapshot_slots<T>(count: usize, work: &mut Work) -> Result<Vec<T>, Error> {
    work.admit_storage(count.checked_mul(std::mem::size_of::<T>()).ok_or(2)?)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| Error::Status(2))?;
    Ok(values)
}

async fn snapshot_vec<T: SnapshotValue>(
    source: &SharedState,
    select: impl Fn(&State) -> &[T],
    cancel: &Cancel,
    work: &mut Work,
) -> Result<Vec<T>, Error> {
    work.checkpoint(cancel).await?;
    let count = select(&source.borrow()).len();
    let mut values = snapshot_slots(count, work)?;
    for index in 0..count {
        values.push(snapshot_value(source, |s| select(s).get(index), cancel, work).await?);
    }
    Ok(values)
}

fn snapshot_node_bytes<T>() -> Result<usize, Error> {
    // Conservatively charge a whole B-tree node per binding, not merely the
    // occupied key/value slot. 16 slots/links cover std's 11-slot nodes and
    // their parent/child links, including sparse roots and insertion splits.
    std::mem::size_of::<(String, T)>()
        .checked_add(std::mem::size_of::<usize>())
        .and_then(|slot| slot.checked_mul(16))
        .ok_or_else(|| Error::Status(2))
}

async fn snapshot_map<T: SnapshotValue>(
    source: &SharedState,
    select: impl Fn(&State) -> &BTreeMap<String, T>,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<BTreeMap<String, T>, Error> {
    use std::ops::Bound::{Excluded, Unbounded};
    let mut values: BTreeMap<String, T> = BTreeMap::new();
    loop {
        work.checkpoint(cancel).await?;
        let (key, value, bytes) = {
            let state = source.borrow();
            let map = select(&state);
            let next = match values.last_key_value() {
                Some((key, _)) => map
                    .range::<str, _>((Excluded(key.as_str()), Unbounded))
                    .next(),
                None => map.iter().next(),
            };
            let Some((key, value)) = next else {
                break;
            };
            let bytes = key.len().checked_add(value.snapshot_bytes()).ok_or(2)?;
            work.admit_storage(snapshot_node_bytes::<T>()?.checked_add(bytes).ok_or(2)?)?;
            (key.clone(), value.clone(), bytes)
        };
        // Install before yielding: this copied key is the allocation-free
        // cursor for the next source lookup, and no source borrow survives.
        values.insert(key, value);
        snapshot_steps(bytes, cancel, work).await?;
    }
    Ok(values)
}

async fn snapshot_set(
    source: &SharedState,
    select: impl Fn(&State) -> &BTreeSet<String>,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<BTreeSet<String>, Error> {
    use std::ops::Bound::{Excluded, Unbounded};
    let mut values: BTreeSet<String> = BTreeSet::new();
    loop {
        work.checkpoint(cancel).await?;
        let (value, bytes) = {
            let state = source.borrow();
            let set = select(&state);
            let next = match values.last() {
                Some(key) => set
                    .range::<str, _>((Excluded(key.as_str()), Unbounded))
                    .next(),
                None => set.iter().next(),
            };
            let Some(value) = next else {
                break;
            };
            let bytes = value.len();
            work.admit_storage(snapshot_node_bytes::<()>()?.checked_add(bytes).ok_or(2)?)?;
            (value.clone(), bytes)
        };
        values.insert(value);
        snapshot_steps(bytes, cancel, work).await?;
    }
    Ok(values)
}

/// Prefix values are visible to later RHS expansions. Parameter assignments
/// update the saved caller value too, so completed effects survive cancellation
/// or removal of the temporary environment. No borrow crosses an await.
pub(crate) struct PrefixFrame {
    state: SharedState,
    active: bool,
}
impl PrefixFrame {
    pub(crate) fn enter(state: SharedState) -> Self {
        state.borrow_mut().prefixes.push(BTreeMap::new());
        Self {
            state,
            active: true,
        }
    }
    pub(crate) fn set(&self, name: String, value: String) -> Result<(), String> {
        let mut state = self.state.borrow_mut();
        if state.scalar_target(&name).ok().flatten().is_none() {
            return Err(name);
        }
        let name = state.assignment_name(name).map_err(|_| String::new())?;
        if state.is_readonly(&name) {
            return Err(name);
        }
        let previous = state.variables.insert(name.clone(), value);
        state
            .prefixes
            .last_mut()
            .unwrap()
            .entry(name)
            .or_insert(previous);
        Ok(())
    }
    pub(crate) fn commit(mut self) {
        self.state.borrow_mut().prefixes.pop();
        self.active = false;
    }
}
impl Drop for PrefixFrame {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = self.state.borrow_mut();
        let saved = state.prefixes.pop().unwrap();
        // At most the admitted command argument count. Destructors finish
        // restoration synchronously even after cancellation, like FunctionFrame.
        for (name, value) in saved {
            if let Some(value) = value {
                state.variables.insert(name, value);
            } else {
                state.variables.remove(&name);
            }
        }
    }
}

/// No borrow is held over an await. Dropping a cancelled function future restores
/// the positional/local frame, including when it is nested inside another call.
pub(crate) struct FunctionFrame {
    state: SharedState,
    positional: Vec<String>,
}
impl FunctionFrame {
    pub(crate) fn enter(state: SharedState, args: Vec<String>, limit: usize) -> Result<Self, i32> {
        let mut s = state.borrow_mut();
        if s.locals.len() >= limit {
            return Err(2);
        }
        let positional = std::mem::replace(&mut s.positional, args);
        s.locals.push(BTreeMap::new());
        drop(s);
        Ok(Self { state, positional })
    }
}
impl Drop for FunctionFrame {
    fn drop(&mut self) {
        let mut s = self.state.borrow_mut();
        s.positional = std::mem::take(&mut self.positional);
        if let Some(locals) = s.locals.pop() {
            for (name, local) in locals {
                restore_nameref(&mut s.namerefs, &name, local.nameref);
                // Only local declarations restore their export attribute;
                // ordinary export changes in functions belong to the caller.
                if local.exported {
                    s.exported.insert(name.clone());
                } else {
                    s.exported.remove(&name);
                }
                if let Some(value) = local.previous {
                    s.variables.insert(name, value);
                } else {
                    s.variables.remove(&name);
                }
            }
        }
    }
}

pub(crate) fn absolute(cwd: &str, path: &str) -> String {
    let path = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    };
    let mut components = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            _ => components.push(part),
        }
    }
    format!("/{}", components.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{FutureExt, task::noop_waker};
    use std::{
        future::Future,
        task::{Context, Poll},
    };

    fn finish_snapshot(
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<State, Error> {
        let mut snapshot = Box::pin(State::snapshot(state, cancel, work));
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        for _ in 0..10_000 {
            if let Poll::Ready(result) = snapshot.as_mut().poll(&mut context) {
                return result;
            }
        }
        panic!("bounded snapshot did not finish");
    }

    #[test]
    fn nameref_snapshot_admits_exact_metadata_before_copying_and_isolates_targets() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .namerefs
            .insert("ref".into(), "target".into());
        let bytes = std::mem::size_of::<RefCell<State>>()
            + 2 * std::mem::size_of::<usize>()
            + "bash".len()
            + "/home/guest".len()
            + snapshot_node_bytes::<String>().unwrap_or_else(|_| panic!("node fits"))
            + 6
            + snapshot_node_bytes::<String>().unwrap_or_else(|_| panic!("node fits"))
            + 9
            + std::mem::size_of::<i32>();
        let mut small = Work::new(100_000, bytes - 1, 0);
        assert!(matches!(
            finish_snapshot(&state, &Cancel::new(), &mut small),
            Err(Error::Status(2))
        ));
        let mut exact = Work::new(100_000, bytes, 0);
        let mut child = finish_snapshot(&state, &Cancel::new(), &mut exact)
            .unwrap_or_else(|_| panic!("exact metadata allowance fits"));
        child
            .assign_parameter("ref".into(), "child".into())
            .unwrap();
        assert_eq!(child.scalar_parameter("ref"), Some("child"));
        assert_eq!(state.borrow().scalar_parameter("ref"), None);
        assert_eq!(state.borrow().namerefs["ref"], "target");
    }

    #[test]
    fn saved_local_reference_targets_are_snapshot_payloads() {
        let state = State::default().shared();
        let target = "t".repeat(128 * 1024);
        state.borrow_mut().namerefs.insert("ref".into(), target);
        let _frame = FunctionFrame::enter(state.clone(), Vec::new(), 4).unwrap();
        state
            .borrow_mut()
            .local("ref".into(), "inner".into())
            .unwrap();
        let mut work = Work::new(1_000_000, 64 * 1024, 0);
        assert!(matches!(
            finish_snapshot(&state, &Cancel::new(), &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(state.borrow().scalar_parameter("ref"), Some("inner"));
    }

    #[test]
    fn scalar_reference_depth_cycles_and_access_cancellation_use_constant_storage() {
        let mut state = State::default();
        for index in 0..64 {
            state
                .namerefs
                .insert(format!("r{index}"), format!("r{}", index + 1));
        }
        state.variables.insert("r64".into(), "value".into());
        assert_eq!(state.scalar_target("r0"), Ok(Some("r64")));
        assert_eq!(state.scalar_parameter("r0"), Some("value"));
        state.namerefs.insert("r63".into(), "r0".into());
        assert_eq!(state.scalar_target("r0"), Ok(None));
        state.namerefs.insert("r63".into(), "r64".into());
        state.namerefs.insert("r64".into(), "end".into());
        assert_eq!(state.scalar_target("r0"), Err(2));
        state.namerefs.insert("r1".into(), "r0".into());
        assert_eq!(state.scalar_target("r0"), Ok(None));

        let state = State::default().shared();
        state
            .borrow_mut()
            .namerefs
            .insert("ref".into(), "t".repeat(100_000));
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 0, 0);
        let mut access = Box::pin(State::admit_scalar_access(
            &state, "ref", &cancel, &mut work,
        ));
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        assert!(access.as_mut().poll(&mut context).is_pending());
        assert!(state.try_borrow_mut().is_ok());
        cancel.cancel();
        assert!(matches!(
            access.as_mut().poll(&mut context),
            Poll::Ready(Err(Error::Status(130)))
        ));
    }

    #[test]
    fn alias_write_admission_precedes_owned_target_growth() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .namerefs
            .insert("r".into(), "target".into());
        let mut work = Work::new(1000, 0, 0);
        assert!(matches!(
            State::admit_assignment(&state, "r", 5, &Cancel::new(), &mut work).now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        assert!(!state.borrow().variables.contains_key("target"));
        assert_eq!(state.borrow().namerefs["r"], "target");
    }

    #[test]
    fn resolved_attribute_keys_and_set_nodes_are_admitted_before_growth() {
        for readonly in [false, true] {
            let state = State::default().shared();
            state
                .borrow_mut()
                .namerefs
                .insert("ref".into(), "target".into());
            let bytes = "target".len() * 3
                + snapshot_node_bytes::<()>().unwrap_or_else(|_| panic!("node size fits"));
            let cancel = Cancel::new();
            let mut small = Work::new(64, bytes - 1, 0);
            assert!(matches!(
                State::attribute_target(&state, "ref", readonly, &cancel, &mut small)
                    .now_or_never(),
                Some(Err(Error::Status(2)))
            ));
            assert!(state.borrow().exported.is_empty());
            assert!(state.borrow().readonly.is_empty());
            let mut exact = Work::new(64, bytes, 0);
            let key = State::attribute_target(&state, "ref", readonly, &cancel, &mut exact)
                .now_or_never()
                .expect("a short reference needs fewer than 64 checkpoints")
                .unwrap_or_else(|_| panic!("exact attribute admission fits"));
            let result = if readonly {
                state.borrow_mut().readonly(key, None)
            } else {
                state.borrow_mut().export(key, None)
            };
            assert_eq!(result, Ok(()));
            assert_eq!(state.borrow().readonly.contains("target"), readonly);
            assert_eq!(state.borrow().exported.contains("target"), !readonly);
            assert!(!state.borrow().variables.contains_key("target"));
            assert_eq!(state.borrow().namerefs["ref"], "target");
        }
    }

    #[test]
    fn cancelled_or_cyclic_attribute_resolution_creates_no_attributes() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .namerefs
            .insert("ref".into(), "t".repeat(100_000));
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 1_000_000, 0);
        let mut declaration = Box::pin(State::attribute_target(
            &state, "ref", true, &cancel, &mut work,
        ));
        assert!(declaration.as_mut().now_or_never().is_none());
        assert!(state.try_borrow_mut().is_ok());
        cancel.cancel();
        assert!(matches!(
            declaration.now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert!(state.borrow().readonly.is_empty());
        assert!(state.borrow().exported.is_empty());

        state
            .borrow_mut()
            .namerefs
            .insert("ref".into(), "ref".into());
        let mut work = Work::new(100_000, 4096, 0);
        let cancel = Cancel::new();
        let mut declaration = Box::pin(State::attribute_target(
            &state, "ref", false, &cancel, &mut work,
        ));
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        for _ in 0..1024 {
            if let Poll::Ready(result) = declaration.as_mut().poll(&mut context) {
                assert!(matches!(result, Err(Error::Status(1))));
                assert!(state.borrow().readonly.is_empty());
                assert!(state.borrow().exported.is_empty());
                return;
            }
        }
        panic!("bounded cycle resolution must finish");
    }

    #[test]
    fn snapshot_rejects_retained_variables_even_when_no_fields_are_emitted() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .variables
            .insert("hidden".into(), "x".repeat(128 * 1024));
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 64 * 1024, 0);
        assert!(matches!(
            finish_snapshot(&state, &cancel, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(state.borrow().variables["hidden"].len(), 128 * 1024);
    }

    #[test]
    fn snapshot_shares_function_payloads_but_isolates_mutable_bindings() {
        let state = State::default().shared();
        let body = Rc::new(Command::Compound(
            shell_parser::parser::CompoundCommand::Arithmetic("x".repeat(128 * 1024)),
            Vec::new(),
        ));
        {
            let mut source = state.borrow_mut();
            source.functions.insert("f".into(), body.clone());
            source.variables.insert("v".into(), "caller".into());
            source.exported.insert("v".into());
            source.readonly.insert("r".into());
            source.positional = vec!["argument".into()];
            source.pipestatus = vec![3, 7];
            source.status = 7;
            source.pipefail = true;
            source.nounset = true;
        }
        // Much less storage than the immutable function payload alone.
        let mut work = Work::new(1_000_000, 16 * 1024, 0);
        let mut child = finish_snapshot(&state, &Cancel::new(), &mut work)
            .unwrap_or_else(|_| panic!("small shared-body snapshot should fit"));
        assert!(Rc::ptr_eq(&child.functions["f"], &body));
        assert_eq!(child.shell_name, "bash");
        assert_eq!(child.cwd, "/home/guest");
        assert_eq!(child.status, 7);
        assert_eq!(child.pipestatus, [3, 7]);
        assert!(child.pipefail);
        assert!(child.nounset);
        assert!(child.exported.contains("v"));
        assert!(child.readonly.contains("r"));
        assert_eq!(child.positional, ["argument"]);
        child.variables.insert("v".into(), "child".into());
        child.functions.remove("f");
        child.exported.clear();
        child.readonly.clear();
        child.positional[0] = "changed".into();
        child.cwd = "/child".into();
        let source = state.borrow();
        assert_eq!(source.variables["v"], "caller");
        assert!(Rc::ptr_eq(&source.functions["f"], &body));
        assert!(source.exported.contains("v"));
        assert!(source.readonly.contains("r"));
        assert_eq!(source.positional, ["argument"]);
        assert_eq!(source.cwd, "/home/guest");
    }

    #[test]
    fn snapshot_preserves_local_and_prefix_restoration_values() {
        let state = State::default().shared();
        {
            let mut source = state.borrow_mut();
            source.locals.push(BTreeMap::from([(
                "local".into(),
                LocalVariable {
                    previous: Some("before local".into()),
                    nameref: None,
                    exported: true,
                    readonly: true,
                },
            )]));
            source.prefixes.push(BTreeMap::from([
                ("prefix".into(), Some("before prefix".into())),
                ("unset".into(), None),
            ]));
        }
        let mut work = Work::new(1_000_000, 16 * 1024, 0);
        let mut child = finish_snapshot(&state, &Cancel::new(), &mut work)
            .unwrap_or_else(|_| panic!("small frame snapshot should fit"));
        let local = &child.locals[0]["local"];
        assert_eq!(local.previous.as_deref(), Some("before local"));
        assert!(local.exported);
        assert!(local.readonly);
        assert_eq!(
            child.prefixes[0]["prefix"].as_deref(),
            Some("before prefix")
        );
        assert_eq!(child.prefixes[0]["unset"], None);
        child.locals[0].get_mut("local").unwrap().previous = None;
        child.prefixes[0].remove("prefix");
        let source = state.borrow();
        assert_eq!(
            source.locals[0]["local"].previous.as_deref(),
            Some("before local")
        );
        assert!(source.prefixes[0].contains_key("prefix"));
    }

    #[test]
    fn snapshot_admits_saved_local_and_prefix_payloads_before_copying() {
        for local in [true, false] {
            let state = State::default().shared();
            if local {
                state.borrow_mut().locals.push(BTreeMap::from([(
                    "v".into(),
                    LocalVariable {
                        previous: Some("x".repeat(128 * 1024)),
                        nameref: None,
                        exported: false,
                        readonly: false,
                    },
                )]));
            } else {
                state
                    .borrow_mut()
                    .prefixes
                    .push(BTreeMap::from([("v".into(), Some("x".repeat(128 * 1024)))]));
            }
            let mut work = Work::new(1_000_000, 64 * 1024, 0);
            assert!(matches!(
                finish_snapshot(&state, &Cancel::new(), &mut work),
                Err(Error::Status(2))
            ));
        }
    }

    #[test]
    fn snapshot_cancellation_precedes_admission_and_releases_borrows_at_yields() {
        let state = State::default().shared();
        let cancel = Cancel::new();
        cancel.cancel();
        let mut work = Work::new(1, 32, 0);
        assert!(matches!(
            State::snapshot(&state, &cancel, &mut work).now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert!(
            work.admit_storage(32).is_ok(),
            "pre-cancel spends no storage"
        );

        state
            .borrow_mut()
            .variables
            .insert("retained".into(), "x".repeat(4096));
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 64 * 1024, 0);
        let mut snapshot = Box::pin(State::snapshot(&state, &cancel, &mut work));
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        assert!(snapshot.as_mut().poll(&mut context).is_pending());
        assert!(
            state.try_borrow_mut().is_ok(),
            "no source borrow crosses a yield"
        );
        cancel.cancel();
        assert!(matches!(
            snapshot.as_mut().poll(&mut context),
            Poll::Ready(Err(Error::Status(130)))
        ));
        drop(snapshot);
        assert_eq!(state.borrow().variables["retained"].len(), 4096);
    }

    #[test]
    fn initial_ifs_is_set_to_bash_default_without_export() {
        // GNU Bash 5.3.15: env -i /usr/bin/bash --noprofile --norc -c
        // 'printf "%s" "$IFS" | /usr/bin/od -An -tx1; declare -p IFS;
        //  printf "<%s>\n" "${IFS+x}"; /usr/bin/printenv IFS'
        // prints 20 09 0a, declare -- IFS=$' \t\n', <x>; printenv exits 1.
        let state = State::default();
        assert_eq!(
            state.variables.get("IFS").map(String::as_str),
            Some(" \t\n")
        );
        assert_eq!(state.parameter("IFS"), " \t\n");
        assert_eq!(state.scalar_parameter("IFS"), Some(" \t\n"));
        assert!(!state.exported.contains("IFS"));
        assert!(!state.environment().contains_key("IFS"));
    }

    #[test]
    fn subsequent_ifs_empty_change_and_removal_do_not_reinitialize_it() {
        let mut state = State::default();

        state.variables.insert("IFS".into(), String::new());
        assert_eq!(state.parameter("IFS"), "");
        assert_eq!(state.scalar_parameter("IFS"), Some(""));
        assert!(!state.environment().contains_key("IFS"));

        state.variables.insert("IFS".into(), ":".into());
        assert_eq!(state.parameter("IFS"), ":");
        assert_eq!(state.scalar_parameter("IFS"), Some(":"));
        assert!(!state.environment().contains_key("IFS"));

        state.variables.remove("IFS");
        assert!(!state.variables.contains_key("IFS"));
        assert_eq!(state.parameter("IFS"), "");
        assert_eq!(state.scalar_parameter("IFS"), None);
        assert_eq!(state.clone().scalar_parameter("IFS"), None);
        assert!(!state.environment().contains_key("IFS"));
    }
}
