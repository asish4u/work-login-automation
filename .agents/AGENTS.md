# Token Optimization and Efficiency Rules

To minimize token usage and optimize speed and performance, adhere to the following rules:

## 1. Response Conciseness
* **Direct and brief**: Keep all explanations, answers, and summaries to the user as short and direct as possible.
* **No duplication**: Do not repeat details, checklists, or steps that are already documented in artifacts (`task.md`, `implementation_plan.md`, `walkthrough.md`) or previous messages.
* **Minimal thoughts**: Keep internal reasoning brief and focused on choices and actions.

## 2. Targeted File Access
* **Line-range reading**: When viewing files using `view_file`, always specify `StartLine` and `EndLine` to read only the lines of interest. Avoid loading the entire file unless it is very small (<50 lines).
* **Precise search**: Locate code sections first using precise grep searches before reading files.

## 3. Minimizing Command Output
* **Limit lines**: When proposing or running terminal commands, ensure output is capped or filtered. Use commands like `head`, `tail`, `grep`, or flags like `git log -n 5`, `pytest --tb=short`, etc.
* **Suppress verbose installer logs**: Use silent/quiet flags (e.g., `-q`, `--quiet`, `--silent`) with package managers (`npm`, `pip`, etc.).

## 4. Surgically Precise Code Edits
* **Precise replacement**: Use `replace_file_content` or `multi_replace_file_content` for precise chunk replacement. Avoid rewriting entire files or large contiguous chunks of code when only a few lines change.
* **Combine edits**: Do not make multiple sequential file edits across separate turns if they can be combined into a single edit or tool call.

## 5. Frugal Artifact and Subagent Management
* **Keep artifacts concise**: Write brief, high-level summaries in artifacts. Avoid placeholders or large blocks of unchanged code.
* **Efficient subagents**: Only spawn subagents when necessary for parallel or context-isolated tasks. Keep subagent prompts minimal and focused.
