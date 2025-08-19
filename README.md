# Cellmate - VS Code Jupyter Notebook AI Feedback Extension

Cellmate is an AI-powered teaching feedback extension designed specifically for VS Code Jupyter Notebooks. It automatically analyzes student code, runs hidden tests, generates personalized feedback, and provides intelligent chat functionality.

## Key Features
### 1. AI Feedback Generation
- **Personalized Feedback**: Generates targeted feedback based on student code and test results
- **Template-based Prompts**: Uses a flexible prompt template system with support for various placeholders

### 2. Prompt Template System
- **Flexible Placeholders**: Supports various types of placeholders and cell references
- **Dynamic Content Filling**: Automatically fills templates based on notebook content
- **Multi-format Support**: Supports HTML comments, Markdown comments, and other formats

## Installation
### **Cellmate is avaiable in VScode plugin market now**

OR:
1. Clone the repository:
```bash
git clone https://github.com/teachnology/cellmate
cd cellmate
```

2. Install dependencies:
```bash
npm install
```

3. Compile the extension:
```bash
npm run compile
```

4. Press `F5` in VS Code to start debugging mode, or package as `.vsix` file for installation
## Usage
### Basic Usage

1. **Open Jupyter Notebook**: Open a `.ipynb` file in VS Code
2. **Write Code**: Write Python code in code cells
3. **Click botton**: Click the AI feedback botton
4. **View Feedback**: The extension will automatically generate feedback and insert it into the notebook

### Error Helper and Error Chat

- **Error Helper**: Automatically analyzes Python errors and provides targeted debugging guidance without giving away answers. 

  When problem description is provided, considers both the error and problem requirements. To include problem just simply mark your problem description:

  ```markdown
  <!-- prompt:problem_description -->
  Calculate the nth Fibonacci number recursively
  ```
  Or in code cells:
  ```python
  # prompt:problem_description
  # Calculate the nth Fibonacci number recursively
  ```

- **Error Chat**: Students can ask follow-up questions about errors in a conversational interface after Error Helper's complete analysis.

#### How to Use Error Helper:
1. **Run Your Code**: Execute a Python cell that produces an error.
2. **Click Error Helper Button**: The 🆘 Error Helper button appears when errors are detected. Or set the button to always show in code cell.
3. **View Analysis**: Get structured feedback including: "What Happened", "Why It Occurred", "How to Fix It", "General Example", "Prevention Tip". Analysis can be displayed as cell output or markdown cell.

#### How to Use Error Chat:
1. **After Error Analysis**: When Error Helper completes, click "Start Chat" in the popup.
2. **Or Use Command Palette**: Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux) → "Start Error Helper Chat".
3. **Ask Questions**: Type your questions in the chat panel.
4. **Get Targeted Help**: Receive feedback based on your error context.

### Expand / Explain and Follow-up Questions

Cellmate provides additional interactive AI tools to help you better understand or refine your work.

#### Expand / Explain Button
- This button can be configured to appear **only in feedback Markdown cells** or **in all Markdown cells**.
- You can select the working mode in VS Code settings:
  - **Expand Mode**: Expand the summary of feedback with more detail, examples, or deeper reasoning.
  - **Explain Mode**: Explains and clarifies selected text or sentence.
    - In Explain Mode, select a portion of text in a Markdown cell and click the **Explain** button.
    - A new *Explanation* Markdown cell will be inserted below, containing the explanation of the selected text.

#### Ask Follow-up Button
- **Where it appears**: In both *Feedback* and *Explanation* Markdown cells.
- **What it does**: Opens a Webview panel where you can have a conversational follow-up with the AI.
- **How to use**:
  1. Click **Ask Follow-up**.
  2. Type your question in the Webview panel.
  3. The AI will respond in real-time.


## 🔧 Configuration
### LLM Configuration

Configure LLM service in VS Code settings:

```json
{
  "jupyterAiFeedback.llm.apiUrl": "http://your-llm-server.com/api",
  "jupyterAiFeedback.llm.apiKey": "your-api-key",
  "jupyterAiFeedback.llm.modelName": "your-model-name"
}
```

### Prompt Template list
The extension will fetching prompt templates from remote repository with the name of the prompt, the remote repository is https://github.com/teachnology/promptfolio/tree/main/prompts. If you design some useful prompts, please contact us and we can add them into the prompt repo.

## 📝 Prompt Placeholder Usage Guide
Cellmate provides a powerful prompt template system that supports various types of placeholders for dynamic content filling.

### 1. Basic Placeholders
#### Simple Text Placeholders
```markdown
<!-- prompt:problem_description -->
This is an exercise to calculate the number of digits
```
This will replace the {{problem_description}} in the prompt templete if it is exist.

#### Hash Comment Format
```python
# prompt: expected_output
The function should return the number of digits in the input number
```
This will replace the {{expected_output}} in the prompt templete if it is exist.

### 2. Multi-block Region Placeholders

For long content or muti-cell contens, you can use start and end markers:

```markdown
<!-- prompt:detailed_instructions:start -->
Please read the following instructions carefully:
```

```markdown
1. The function should accept an integer parameter
2. Return the number of digits in the integer
3. Pay attention to handling negative numbers
<!-- prompt:detailed_instructions:end -->
```
This will take the two cell contents to replace the {{detailed_instructions}} in the prompt templete if it is exist.

### 3. Cell Reference Placeholders
#### Absolute References
- `{{cell:1}}` - Reference content of the 1st cell
- `{{cell:2:md}}` - Reference content of the 2nd Markdown cell
- `{{cell:3:cd}}` - Reference content of the 3rd code cell
#### Relative References
- `{{cell:-1}}` - Reference the previous cell from current cell
- `{{cell:+1}}` - Reference the next cell from current cell
- `{{cell:-2:md}}` - Reference the 2nd Markdown cell before current cell
- `{{cell:+3:cd}}` - Reference the 3rd code cell after current cell

### 4. Usage Examples
#### Prompt Template Example
```markdown
## Problem Description
{{problem_description}}

## Your Code
{{cell}}

## Test Results
{{test_results}}

## Feedback
{{feedback}}

## Improvement Suggestions
{{suggestions}}

## Reference Example
{{cell:1:md}}
```

#### Usage in Notebook
```python
# In code cell
# PROMPT_ID: prompt name in the prompt repo
# EXERCISE_ID: hidden test name in the test repo
def num_digits(n):
    return len(str(n))
```

```markdown
<!-- prompt:problem_description -->
Write a function to calculate the number of digits in a given integer. For example, 123 has 3 digits.
```

### 5. Placeholder Processing Rules
1. Only placeholders declared in the notebook will be processed
2. Cell reference placeholders will match cells of the specified type
3. Multiple blocks with the same key will be automatically concatenated
4. Placeholders not found will be replaced with empty strings


## Project Structure
```
cellmate/
├── src/                  # Source code directory
│   ├── extension.ts      # Main extension file
│   ├── promptUtils.ts    # Prompt template processing
│   ├── testUtils.ts      # Test execution and analysis
│   ├── gitUtils.ts       # Git repository operations
│   ├── configParser.ts   # Configuration parsing
│   ├── apiCaller.ts      # API calling
│   ├── templateUtils.ts  # Template utilities
│   ├── speech.ts         # Speech functionality
│   ├── localServer.ts    # Local server
│   └── ffmpegRecorder.ts # Recording functionality
├── docs/                 # Documentation directory
│   ├── README.md         # Documentation index
│   └── promptUtils.md    # Prompt template system 
├── README.md             # Main project documentation
└── package.json          # Project configuration
```

## Contributing
Issues and Pull Requests are welcome!

### Development Environment Setup
1. Clone the repository
2. Install dependencies: `npm install`
3. Compile: `npm run compile`
4. Press F5 to start debugging