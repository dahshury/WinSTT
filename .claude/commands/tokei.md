# Codebase Analysis with Tokei - LLM Prompt

You are an expert software architect tasked with analyzing a codebase to identify large files that violate DRY (Don't Repeat Yourself), SoC (Separation of Concerns), and modularity principles. Follow these instructions precisely.

## Phase 1: Data Collection

1. **Run the tokei command and export output to a file:**

   ```bash
   tokei -f -s code > docs/tokei_output.txt
   ```

   **Note**: Exporting to a file first is necessary because the output may be too large to process directly.

2. **Read the exported file** (`docs/tokei_output.txt`) and parse it to identify the top 10 files by lines of code (LOC). Extract:
   - File path (relative to project root)
   - Total lines of code
   - File language/type

3. **Filter appropriately:**
   - **Include**: Source code files (main business logic, components, services, utilities, domain models)
   - **Exclude**:
     - Dependency directories (node_modules, venv, vendor, .venv, etc.)
     - Build outputs (build/, dist/, .next/, out/, etc.)
     - Test files (_test_, _spec_, test\_\*, tests/, **tests**/)
     - Configuration files (package.json, tsconfig.json, .eslintrc, config.\*, etc.)
     - Generated files (_.generated._, _.pb._, etc.)
     - Lock files (package-lock.json, yarn.lock, bun.lockb, Gemfile.lock, etc.)
   - **Focus on**: Files that contain business logic, domain models, and core functionality

## Phase 2: Code Analysis

For EACH of the top 10 largest files:

### A. File Purpose & Context

1. **Identify what the file does** - summarize its primary responsibility in 1-2 sentences
2. **Identify why it exists** - what business need or architectural decision led to this file
3. **Identify the file type** - Component, Service, Utility, Domain Model, Helper, Handler, etc. (based on actual file role, not naming)
4. **Identify the feature/domain area** - Which logical domain or feature the file belongs to
5. **Check the file** for:
   - Main exports and their purposes
   - Key functions/classes and their roles
   - Dependencies on other modules

### B. Violation Analysis

For each violation category below, assign a star rating (⭐ system):

- **⭐⭐⭐⭐⭐ (5 stars)**: Minimal violation, file is well-structured
- **⭐⭐⭐⭐ (4 stars)**: Minor violations, mostly good separation
- **⭐⭐⭐ (3 stars)**: Moderate violations, some refactoring needed
- **⭐⭐ (2 stars)**: Significant violations, considerable refactoring needed
- **⭐ (1 star)**: Severe violations, major refactoring required

#### DRY Violations (Don't Repeat Yourself)

Analyze:

- Repeated logic patterns or algorithms
- Duplicated condition checks or validations
- Similar functions with minor variations
- Copy-pasted code blocks
- Repeated type definitions or interfaces

**Severity Indicators:**

- ⭐: Multiple (5+) identical or near-identical code blocks
- ⭐⭐: 3-4 instances of duplication
- ⭐⭐⭐: 1-2 minor duplication patterns
- ⭐⭐⭐⭐: Minimal duplication, well-extracted utilities
- ⭐⭐⭐⭐⭐: No detectable duplication

#### SoC Violations (Separation of Concerns)

Analyze:

- Mixed responsibilities (business logic + UI + data access)
- Files handling multiple unrelated domains
- Business logic intertwined with framework code
- API layer mixed with domain logic
- State management mixed with rendering logic
- Cross-cutting concerns not abstracted

**Severity Indicators:**

- ⭐: 4+ distinct concerns mixed together
- ⭐⭐: 3 distinct concerns mixed together
- ⭐⭐⭐: 2 concerns mixed, but one is minor
- ⭐⭐⭐⭐: Clear primary concern with minor cross-cutting
- ⭐⭐⭐⭐⭐: Single, well-defined concern

#### Modularity Violations

Analyze:

- Poor cohesion (related code scattered)
- High coupling (many external dependencies)
- Difficult to reuse components
- Complex interdependencies
- Lack of clear interfaces/contracts
- Not following domain-driven design principles
- Functions/classes that are too large (>100 lines for functions, >200 lines for classes)

**Severity Indicators:**

- ⭐: >5 external dependencies, poor reusability, large monolithic sections
- ⭐⭐: 4-5 dependencies, some coupling issues
- ⭐⭐⭐: 2-3 dependencies, mostly good modularity
- ⭐⭐⭐⭐: 1-2 dependencies, well-modularized
- ⭐⭐⭐⭐⭐: Excellent modularity, highly reusable, clear interfaces

#### Refactoring Effort Assessment

Determine the **estimated effort** required to refactor the file based on:

- **LOC volume**: More lines = more time
- **Complexity**: How intertwined the violations are
- **Dependencies**: How many other files depend on this file
- **Scope of changes**: Whether refactoring requires touching other files
- **Testing requirements**: Whether tests need to be updated/created

**Effort Levels:**

- **🟢 Low** (1-2 days): <300 LOC, isolated violations, few external dependencies, mostly SoC fixes
- **🟡 Medium** (2-5 days): 300-700 LOC, moderate violations, some dependencies, requires careful planning
- **🔴 High** (1-2 weeks): >700 LOC, severe violations, many dependencies, significant risk, requires architecture review
- **⚫ Critical** (2+ weeks): >1000 LOC, multiple critical violations, widespread impact, potential system redesign needed

## Phase 3: Refactoring Identification

For each file, identify the **top 3-5 most problematic blocks** that need refactoring:

For each block:

1. **Location**: Line number range (if possible)
2. **Size**: Approximate LOC
3. **Issue**: What principle(s) it violates (DRY/SoC/Modularity)
4. **Refactoring suggestion**: Specific recommendation (e.g., "Extract to utility module", "Split into multiple classes", "Create abstract base class")

## Phase 4: Output Generation

Create separate markdown tables in `/docs/file-analysis.md` for each programming language/file type identified. Generate one table per language/file type (e.g., by language detected by tokei, grouped logically).

### Sorting Formula - Refactoring Priority Score

Before creating tables, calculate a **Refactoring Priority Score** for each file to determine sort order:

```
Priority Score = (10 - Average_Rating) / Effort_Factor

Where:
- Average_Rating = (DRY_Stars + SoC_Stars + Modularity_Stars) / 3 (range 1-5)
- 10 - Average_Rating = Severity (range 5-9, higher = worse violations)
- Effort_Factor: Low=1, Medium=1.5, High=2.5, Critical=4

Result: Higher score = Higher Priority (tackle first)
```

**Example Calculations:**

- File with ⭐ violations, Low effort: (10-1) / 1 = **9.0** ← Fix ASAP
- File with ⭐⭐ violations, Medium effort: (10-2) / 1.5 = **5.3** ← High priority
- File with ⭐⭐⭐ violations, High effort: (10-3) / 2.5 = **2.8** ← Medium priority
- File with ⭐⭐⭐⭐ violations, Critical effort: (10-4) / 4 = **1.5** ← Defer/plan

**Rationale**: This formula balances severity with feasibility. Severely problematic files are prioritized, but extreme effort acts as a resistance factor. Teams should tackle high-scoring items first (best ROI on refactoring time).

### Table Structure

Generate tables organized by language/file type:

```markdown
# Top 10 Largest Files - Refactoring Analysis

**Generated**: [Current Date]
**Command Run**: `tokei -f -s code`

---

## [Language Name] - [File Type if applicable]

| Rank | File Path | Responsibilities | LOC | DRY | SoC | Mod | Avg | Effort | Priority Score | Key Refactoring Needs |
| ---- | --------- | ---------------- | --- | --- | --- | --- | --- | ------ | -------------- | --------------------- |

---
```

Repeat the `[Language Name]` sections for each language found (sorted within each language by Priority Score, descending).

### Table Column Specifications:

- **Rank**: Priority ranking (1 = highest priority within that language group, sorted by Priority Score descending)
- **File Path**: Full path relative to project root
- **Domain**: Logical domain/feature area the file belongs to
- **Responsibilities**: 1-2 sentence summary of what the file does and its core purpose(s)
- **LOC**: Exact line count from tokei
- **DRY**: Star rating (⭐ to ⭐⭐⭐⭐⭐)
- **SoC**: Star rating (⭐ to ⭐⭐⭐⭐⭐)
- **Mod**: Star rating (⭐ to ⭐⭐⭐⭐⭐)
- **Avg**: Average of three ratings (round to 1 decimal, range 1.0-5.0)
- **Effort**: Refactoring effort level (🟢 Low / 🟡 Medium / 🔴 High / ⚫ Critical)
- **Priority Score**: Calculated score (higher = more urgent, format to 1 decimal place)
- **Key Refactoring Needs**: 1-sentence summary of top refactoring action

### Detailed Analysis Sections

After the main tables, create detailed sections for each file:

```markdown
## Detailed Analysis

### 1. [File Path] ([LOC] LOC) - [File Type] - [Domain]

**Responsibilities**: [1-2 sentence description of what the file does]

**Purpose**: [2-sentence explanation of its role in the system]

**Why It Exists**: [1-2 sentence business/architectural context]

**Violation Scores**:

- DRY Violations: ⭐⭐ - [Specific examples of duplication]
- SoC Violations: ⭐⭐⭐ - [Specific examples of mixed concerns]
- Modularity Violations: ⭐ - [Specific examples of poor modularity]

**Refactoring Effort**: 🟡 Medium (3-4 days) - [Justification based on LOC, complexity, dependencies]

**Analysis**:
[2-3 paragraphs analyzing the file structure and main issues]

**Critical Refactoring Blocks**:

1. **Lines XXX-XXX** ([NN] LOC)
   - Issue: [Specific DRY/SoC/Modularity violation]
   - Suggestion: [Concrete refactoring action]

2. **Lines XXX-XXX** ([NN] LOC)
   - Issue: [Specific violation]
   - Suggestion: [Concrete refactoring action]

3. **Lines XXX-XXX** ([NN] LOC)
   - Issue: [Specific violation]
   - Suggestion: [Concrete refactoring action]

---
```

## Phase 5: Quality Checks

Before finalizing the output:

1. **Verify accuracy**: Re-check the `docs/tokei_output.txt` file for correct LOC counts
2. **Consistency**: Ensure star ratings are consistently applied across all files
3. **Actionability**: Each suggestion should be specific and implementable
4. **Context**: Ratings should reflect actual code patterns seen in the file
5. **Completeness**: All 10 files have full analysis

## Critical Requirements

- **Be thorough**: Read and analyze the actual code, not just filenames
- **Be honest**: Don't just give high ratings to short files; evaluate based on principles
- **Be specific**: Point to actual code patterns, not vague statements
- **Be fair**: Consider the complexity domain and file context
- **Be practical**: Suggestions should be realistic and valuable

## Output File Location

Save the complete analysis to:

```
/docs/file-analysis.md
```

Ensure the file is properly formatted Markdown with clear section headers and tables.
