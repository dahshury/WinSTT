# Commit Feature

## Overview

Steps to take when pushing features to github

## Workflow

# Changelog

1. **VERIFY CURRENT DATE FIRST**: Get current date from system before updating changelog
   - Command: `date +"%Y-%m-%d"` or check system date/time
   - **CRITICAL**: Always use actual current date - never guess or use relative dates like "today"
   - Format: YYYY-MM-DD (e.g., "2025-01-27")
2. If you have not done so yet, create / update the changelog summary for relevant issue within your project's changelog directory

### Changelog Update Notes

- **File Location**: `changelog/[ISSUE_ID]_[FEATURE_NAME].md` (e.g., `ISSUE-40_WELCOME_EMAIL_SEQUENCE.md`)
- **Update Timing**: Update changelog BEFORE creating commit (so commit message can reference it)
- **Date Verification**:
  - **MANDATORY**: Run `date +"%Y-%m-%d"` or use `run_terminal_cmd` to get current system date
  - **Never assume date** - always verify from computer/system
  - Use verified date in: "Complete - YYYY-MM-DD", "Last Updated: YYYY-MM-DD", implementation summaries
  - If you're unsure of the date, STOP and verify it before proceeding
- **What to Update**:
  - Mark completed phases with ✅ and "Complete - YYYY-MM-DD" date (use verified date)
  - Update "Files Modified" section with actual file paths and line counts
  - Add implementation summary section at bottom for major milestones
  - Update "Last Updated" timestamp with verified current date
- **Format**: Match existing changelog structure with phases, checkboxes, file lists, and notes sections
- **Status Symbols**: Use ✅ for complete, 🔄 for in progress, ⏳ for pending

# Github

1. Confirm we are NOT on a main branch
2. If we are on main branch, create a new feature branch
3. If we are already on a feature or chore branch, stay on it
4. Run `git diff --staged` to see changes
5. Create a commit message with:
   - Detailed description
   - Main files changes
   - Every file touched
   - Affected components
6. Push locally and to remote branch

### Git Workflow Notes

#### Step 1-3: Branch Verification

- **Check Current Branch**: `git branch --show-current` or `git status`
- **Protected Branches**: Never commit to `main`, `master`, or production branches
- **If on Main**: Create feature branch: `git checkout -b feature/feature-name` or `issue-id-description`
- **Branch Naming**: Use format like `feature/descriptive-name` or `issue-id/feature-name`

#### Step 4: Review Changes

- **Stage Files**: `git add <file>` or `git add -A` (if needed before diff)
- **View Staged**: `git diff --staged` shows what will be committed
- **View Stats**: `git diff --staged --stat` shows file list with line counts
- **Verify**: Only commit relevant files (exclude temp files, node_modules, etc.)

#### Step 5: Commit Message Format

**Before Writing Commit**: If commit message includes dates, verify current date first (see Changelog section Step 1)

Use conventional commit format with detailed body:

```
feat: [short summary] ([ISSUE-ID])

[Detailed description explaining what and why]

## What Changed
- [Main accomplishment 1]
- [Main accomplishment 2]

## Files Changed
- ✅ `path/to/file.ts` - +X insertions, -Y deletions
  - [Specific changes made]
- ✅ `path/to/new-file.ts` - Created (X lines)

## Affected Components
- [Component/system affected]

## Next Steps
- [Remaining work items]

Related: [ISSUE-ID]
```

**Commit Message Best Practices**:

- Start with type: `feat:`, `fix:`, `refactor:`, `docs:`, etc.
- Include issue ID in parentheses if applicable: `(ISSUE-40)`
- Use present tense: "add" not "added", "update" not "updated"
- List EVERY file touched (use `git diff --staged --name-only` to verify)
- Include line count stats from `git diff --staged --stat`
- Explain business impact in "Affected Components" when relevant
- **Dates**: If including dates, verify current date using `date +"%Y-%m-%d"` - never guess dates

#### Step 6: Push to Remote

- **First Push**: `git push -u origin <branch-name>` (sets upstream tracking)
- **Subsequent Pushes**: `git push` (if upstream already set)
- **Save Commit Hash**: Note the commit hash (e.g., `138826d`) for issue tracking updates
  - Get hash: `git log -1 --format="%h"` or from `git push` output
  - **PR Link**: GitHub will provide PR creation link in push output - save for issue tracking comments

## Issue Tracking (Optional)

1. If user provided an issue tracking system (Linear, Jira, GitHub Issues, etc.), update the relevant issue with the same details as local workspace changelog
2. Find the issue's connected project and put an activity update (Note: Do not update description, add activity comment)

### Issue Update Workflow

- Step 1: Find the Issue
- Step 2: Create Activity Comment
- Step 3: Comment Format Template
  **Before Writing Comment**: If comment includes dates, verify current date first using `date +"%Y-%m-%d"` or `run_terminal_cmd` - never guess dates

Match the changelog structure with this format:

```markdown
## Phase X Completed: [Feature Name] ✅

**Date**: YYYY-MM-DD (use verified current date from system)
**Branch**: `branch-name`
**Commit**: abc1234

### [Main Accomplishment]

- [Detail 1]
- [Detail 2]

### Files Changed

- ✅ `path/to/file.ts` - +X insertions, -Y deletions
  - [Specific changes made]

### Next Steps

- [Remaining phase items]

**Business Impact**:

- [Impact notes]

**GitHub**: [Pull Request](link)
```

#### Key Notes

- **Project Info**: Check your issue tracking system for project context
- **Comment Location**: Activity comment appears in issue timeline (not description)
- **Matching Changelog**: Use same structure, checkmarks, and details as local changelog file
- **Links**: Include GitHub branch/PR links when available

## Best practices

- Use present tense
- Explain what and why and how
- NEVER push to main branch without explicit valid confirmation two times in a row from the user
