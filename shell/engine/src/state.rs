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
pub struct State {
    pub variables: BTreeMap<String, String>,
    pub exported: BTreeSet<String>,
    pub cwd: String,
    pub functions: BTreeMap<String, Command>,
    pub status: i32,
    pub pipestatus: Vec<i32>,
    pub pipefail: bool,
    pub(crate) positional: Vec<String>,
    pub(crate) locals: Vec<BTreeMap<String, (Option<String>, bool)>>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            variables: BTreeMap::new(),
            exported: BTreeSet::new(),
            cwd: "/home/guest".into(),
            functions: BTreeMap::new(),
            status: 0,
            pipestatus: vec![0],
            pipefail: false,
            positional: Vec::new(),
            locals: Vec::new(),
        }
    }
}
impl State {
    pub fn shared(self) -> SharedState {
        Rc::new(RefCell::new(self))
    }
    pub(crate) fn parameter(&self, name: &str) -> Cow<'_, str> {
        match name {
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
    pub(crate) fn environment(&self) -> BTreeMap<String, String> {
        self.exported
            .iter()
            .filter_map(|name| self.variables.get(name).map(|v| (name.clone(), v.clone())))
            .collect()
    }
    pub(crate) fn local(&mut self, name: String, value: String) -> Result<(), i32> {
        let previous = (
            self.variables.get(&name).cloned(),
            self.exported.contains(&name),
        );
        self.locals
            .last_mut()
            .ok_or(1)?
            .entry(name.clone())
            .or_insert(previous);
        self.variables.insert(name, value);
        Ok(())
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
            for (name, (value, exported)) in locals {
                // Only local declarations restore their export attribute;
                // ordinary export changes in functions belong to the caller.
                if exported {
                    s.exported.insert(name.clone());
                } else {
                    s.exported.remove(&name);
                }
                if let Some(value) = value {
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
