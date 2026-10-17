//! Original shell state. Open descriptors and filesystem objects live outside
//! this value: isolated shell environments copy rules/state, never byte streams.
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
    exported: bool,
    readonly: bool,
}

#[derive(Clone, Debug)]
pub struct State {
    pub shell_name: String,
    pub variables: BTreeMap<String, String>,
    pub exported: BTreeSet<String>,
    pub readonly: BTreeSet<String>,
    pub cwd: String,
    pub functions: BTreeMap<String, Command>,
    pub status: i32,
    pub pipestatus: Vec<i32>,
    pub pipefail: bool,
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
            cwd: "/home/guest".into(),
            functions: BTreeMap::new(),
            status: 0,
            pipestatus: vec![0],
            pipefail: false,
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
    pub(crate) fn parameter(&self, name: &str) -> Cow<'_, str> {
        match name {
            "0" => Cow::Borrowed(&self.shell_name),
            "?" => Cow::Owned(self.status.to_string()),
            "PWD" => Cow::Borrowed(&self.cwd),
            "#" => Cow::Owned(self.positional.len().to_string()),
            _ => name
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|n| self.positional.get(n))
                .or_else(|| self.variables.get(name))
                .map(|value| Cow::Borrowed(value.as_str()))
                .unwrap_or(Cow::Borrowed("")),
        }
    }
    pub(crate) fn scalar_parameter(&self, name: &str) -> Option<&str> {
        if name == "PWD" {
            return Some(&self.cwd);
        }
        self.variables.get(name).map(String::as_str)
    }
    pub(crate) fn prefix_saved(&self, name: &str) -> bool {
        self.prefixes
            .last()
            .is_some_and(|saved| saved.contains_key(name))
    }
    pub(crate) fn assign_parameter(&mut self, name: String, value: String) -> Result<(), i32> {
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
        if self.readonly.contains(&name) || self.current_local_readonly(&name) {
            return Err(1);
        }
        let previous = LocalVariable {
            previous: self.variables.get(&name).cloned(),
            exported: self.exported.contains(&name),
            readonly: false,
        };
        self.locals
            .last_mut()
            .ok_or(1)?
            .entry(name.clone())
            .or_insert(previous);
        self.variables.insert(name, value);
        Ok(())
    }
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
