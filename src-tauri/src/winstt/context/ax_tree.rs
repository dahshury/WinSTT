use once_cell::sync::Lazy;
use regex::Regex;

use crate::helpers::regex::static_regex;

static JSON_TAG_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"<[^>]+>"));
static JSON_ROLE_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"^</?\s*([a-z][a-z0-9]*)"));
static JSON_NAME_ATTR_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"\bname="([^"]*)""#));
static JSON_FOCUS_ATTR_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"\bfocus="1""#));

#[derive(Debug, Clone)]
pub(super) struct JsonAxNode {
    pub(super) children: Vec<usize>,
    pub(super) focused: bool,
    pub(super) name: String,
    pub(super) role: String,
    pub(super) text: String,
}

#[derive(Debug, Clone)]
pub(super) struct JsonAxTree {
    pub(super) nodes: Vec<JsonAxNode>,
}

impl JsonAxTree {
    fn new() -> Self {
        Self {
            nodes: vec![JsonAxNode {
                children: Vec::new(),
                focused: false,
                name: String::new(),
                role: "root".to_string(),
                text: String::new(),
            }],
        }
    }

    fn push_node(&mut self, parent: usize, node: JsonAxNode) -> usize {
        let idx = self.nodes.len();
        self.nodes.push(node);
        self.nodes[parent].children.push(idx);
        idx
    }
}

struct JsonParsedTag {
    focused: bool,
    is_close: bool,
    name: String,
    role: String,
    self_close: bool,
}

fn json_unescape_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn json_append_text(tree: &mut JsonAxTree, node: usize, between: &str) {
    let trimmed = between.trim();
    if trimmed.is_empty() {
        return;
    }
    let piece = json_unescape_entities(trimmed);
    let target = &mut tree.nodes[node];
    if target.text.is_empty() {
        target.text = piece;
    } else {
        target.text.push(' ');
        target.text.push_str(&piece);
    }
}

fn json_classify_tag(tag: &str) -> Option<JsonParsedTag> {
    let role = JSON_ROLE_RE.captures(tag)?.get(1)?.as_str().to_lowercase();
    let name = JSON_NAME_ATTR_RE
        .captures(tag)
        .and_then(|caps| caps.get(1))
        .map(|m| json_unescape_entities(m.as_str()))
        .unwrap_or_default();
    Some(JsonParsedTag {
        focused: JSON_FOCUS_ATTR_RE.is_match(tag),
        is_close: tag.starts_with("</"),
        name,
        role,
        self_close: tag.trim_end().ends_with("/>"),
    })
}

fn json_apply_tag(tree: &mut JsonAxTree, stack: &mut Vec<usize>, tag: &str) {
    let Some(parsed) = json_classify_tag(tag) else {
        return;
    };
    if parsed.is_close {
        if stack.len() > 1 {
            stack.pop();
        }
        return;
    }
    let parent = *stack.last().unwrap_or(&0);
    let idx = tree.push_node(
        parent,
        JsonAxNode {
            children: Vec::new(),
            focused: parsed.focused,
            name: parsed.name,
            role: parsed.role,
            text: String::new(),
        },
    );
    if !parsed.self_close {
        stack.push(idx);
    }
}

pub(super) fn json_parse_ax_html(ax: &str) -> JsonAxTree {
    let mut tree = JsonAxTree::new();
    let mut stack = vec![0usize];
    let mut last_index = 0usize;
    for mat in JSON_TAG_RE.find_iter(ax) {
        let current = *stack.last().unwrap_or(&0);
        json_append_text(&mut tree, current, &ax[last_index..mat.start()]);
        last_index = mat.end();
        json_apply_tag(&mut tree, &mut stack, mat.as_str());
    }
    let current = *stack.last().unwrap_or(&0);
    json_append_text(&mut tree, current, &ax[last_index..]);
    tree
}
