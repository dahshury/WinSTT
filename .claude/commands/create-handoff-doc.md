# Command: Create Handoff Documentation for Issue/Bug Transfer

## Description

Creates a comprehensive, well-structured handoff document that allows another LLM or engineer to continue working on a specific issue, bug, or feature without needing the original conversation context. The document must be self-contained and provide all necessary context, code references, and investigation paths.

## Role

You are an expert technical writer and software engineer specializing in creating clear, actionable handoff documentation. Your job is to analyze the current issue, extract all relevant context, and create a structured document that enables seamless continuation of work.

## When to Use This Command

- When transferring a conversation to another model or engineer
- When documenting a complex bug that requires investigation
- When creating a handoff for a partially completed feature
- When documenting an issue that needs further debugging

## Inputs You Will Receive

1. **Issue Description**: A clear description of the problem or task
2. **Component Location**: File paths, line numbers, and relevant code sections
3. **Current State**: What has been implemented or attempted
4. **Expected Behavior**: What should happen
5. **Actual Behavior**: What is currently happening
6. **Related Files**: All files involved in the issue

## Document Structure Requirements

The handoff document MUST follow this exact structure:

### 1. Title and Problem Statement

```markdown
# [Component Name] [Issue Type]

## Problem
[Clear, concise description of the issue. Include specific symptoms, error messages, or unexpected behavior. Use bold for critical details.]
```

### 2. Component Location

```markdown
## Component Location
- **Main component**: `[full/path/to/file.tsx]`
- **Related components**: `[full/path/to/other/file.tsx]`
- **Lines of interest**: [File].tsx lines [X-Y] ([description])
- **Configuration files**: `[full/path/to/config.ts]`
```

### 3. Current Implementation

```markdown
## Current Implementation

[Brief description of how the component/feature currently works]

### Key Code Section ([File].tsx ~[X-Y]):

\`\`\`typescript
[Actual code snippet with line numbers if possible]
\`\`\`

[Additional code sections as needed]
```

### 4. Working Reference Implementation (if applicable)

```markdown
## Working Reference Implementation

[Component/pattern that works correctly and can be used as reference]

[File path and key differences or patterns to follow]
```

### 5. Expected vs Actual Behavior

```markdown
## What Should Happen
1. [Step-by-step expected behavior]
2. [Next step]
3. [Final expected outcome]

## What's Currently Happening
1. [Step-by-step actual behavior]
2. [Where it deviates]
3. [Final actual outcome]
```

### 6. Attempted Fixes

```markdown
## Attempted Fixes
1. [Fix attempt 1] - [Brief result]
2. [Fix attempt 2] - [Brief result]
3. [Fix attempt 3] - [Brief result]
[Continue as needed]
```

### 7. Investigation Needed

```markdown
## Investigation Needed
- [Specific area to investigate]
- [Potential root cause to verify]
- [Comparison needed]
- [Timing/race condition to check]
- [Library/framework behavior to verify]
```

### 8. Related Files

```markdown
## Related Files
- `[path/to/file.tsx]` - [Purpose/role]
- `[path/to/file.tsx]` - [Purpose/role]
- `[path/to/file.tsx]` - [Purpose/role]
```

## Content Requirements

### Code Quotations

- **MUST include actual code snippets** for all relevant sections
- Use code blocks with proper language tags (typescript, javascript, etc.)
- Include line number ranges when possible (e.g., `lines 330-395`)
- Quote complete functions or components, not just fragments
- If code is too long, include the most critical parts and note where to find the rest

### Context and State

- Document all relevant state variables, refs, and hooks
- Include prop types and component interfaces
- Document event handlers and their purposes
- Include any configuration or constants that affect behavior

### Dependencies

- List all relevant imports and dependencies
- Note any library versions if relevant
- Document any external services or APIs involved

### Patterns and Conventions

- Note any codebase-specific patterns being used
- Document any architectural decisions relevant to the issue
- Include any workspace rules or conventions that apply

## Quality Standards

### Clarity

- Use clear, concise language
- Avoid ambiguity - be specific about file paths, line numbers, and behavior
- Use bullet points and numbered lists for readability
- Include examples where helpful

### Completeness

- The document must be self-contained
- A new engineer/LLM should be able to understand and continue work without the original conversation
- Include all necessary context, even if it seems obvious
- Don't assume prior knowledge of the codebase

### Accuracy

- All file paths must be correct and relative to the workspace root
- All code snippets must be accurate (copy-paste from actual files)
- All line numbers must be verified
- All behavior descriptions must be precise

## Output Format

1. **File Location**: Save the document in the workspace root with a descriptive name:
   - Format: `[COMPONENT]_[ISSUE_TYPE]_ISSUE.md`
   - Example: `COLUMN_MENU_FILTER_SUBMENU_ISSUE.md`

2. **File Structure**: Follow the exact structure outlined above

3. **Markdown Formatting**:
   - Use proper heading hierarchy (## for main sections, ### for subsections)
   - Use code blocks with syntax highlighting
   - Use bold for emphasis on critical information
   - Use bullet points and numbered lists appropriately

## Execution Steps

1. **Gather Information**:
   - Read all relevant files mentioned
   - Extract current implementation code
   - Identify all related components and dependencies
   - Review any working reference implementations

2. **Document Current State**:
   - Write the problem statement clearly
   - Document all component locations with exact paths
   - Include all relevant code sections with proper formatting
   - List all attempted fixes with results

3. **Document Expected Behavior**:
   - Clearly describe what should happen
   - Describe what is currently happening
   - Highlight the discrepancy

4. **Provide Investigation Paths**:
   - List specific areas to investigate
   - Suggest potential root causes
   - Reference working implementations for comparison
   - Note any timing, state management, or library behavior to verify

5. **Create the Document**:
   - Write the complete markdown document
   - Save it to the workspace root
   - Verify all file paths and code snippets are accurate

## Example Output Structure

See `COLUMN_MENU_FILTER_SUBMENU_ISSUE.md` in the workspace root for a complete example of the expected output format.

## Notes

- This document is meant to be a complete handoff - include everything needed to continue work
- Prioritize clarity and completeness over brevity
- When in doubt, include more context rather than less
- The document should enable someone to pick up the work immediately without asking questions
