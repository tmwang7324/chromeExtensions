--- 
name: learning-log-instructions
applyTo: "**/*.py, **/*.ts, **/*.tsx, **/*.md"
description: Guidelines for persisting reasoning sessions, ensuring consistency, traceability, and reproducibility of architectural decisions and implementation steps.
---
# Learning Log Instructions

You will follow the standards outlined in this markdown file in order to persist reasoning sessions across different features and plans, guaranteeing consistency, traceability, and reproducibility of architectural decisions and implementation steps. The user will most likely reference the logic recorded in log files to further improve implementation and add new features.

## Documentation Standards
- **IMPLEMENTATION.md:** This repository uses a strict implementation and PLAN tracker. All architectural decisions, technology choices, and implementation steps must be documented in this file to ensure consistency, maintainability, and scalability across the project. These choices should explicitly mapped to numbered execution steps and organized by sections based on feature or module. 

## Logging Standards 
- **Rationale Logs:** Whenever architectural planning or programmatic reasoning is made, it should be documented in detail, explaining the choices, trade-offs, and considerations that influenced the decisions. Put your rationale into a markdown `./LOG.md`. Do not overwrite past logs; append to them.

- **Traceability:** Each log entry in `./LOG.md` should reference specific sections or checkpoints in `IMPLEMENTATION.md` to create a clear link between the rationale and the execution steps. This ensures that future developers can easily understand the context behind each decision and how it relates to the overall implementation.

- **Code Skeletons:** When a new architectural feature or component is implemented, include a code skeleton both in IMPLEMENTATION.md and LOG.md to illustrate the usage of libraries, logical/data flow, and sustainable code structure. Additionally, clearly break lines of the code skeleton down with comments to explain the purpose and functionality of each part, ensuring that the reasoning behind the implementation is transparent and easily understandable.

- **Log Formatting:** All entries in `./LOG.md` should follow a consistent format, including a timestamp, the context or feature being addressed as a label, and a detailed description of the rationale or decision made. Each log entry should be at least 20 words.

**MUST READ** however, if there has been more than one failed attempt or workaround for the same issue, it must be explicitly documented in the "Applied Learning Architecture" section. Furthermore, if more than 300 words have been added to `LOG.md`, summarize the key points of reasoning in `LOG.md`.

## Applied Learning Copilot Instructions
- **Applied Learning Log:** The end of `copilot-instructions.md` should contain an "Applied Learning Architecture" section. This tracks session progress, pivots, and specific topics that required user reprompting or correction. When something fails repeatedly, when the user has to re-explain, or when a workaround is found for a platform/tool limitation, add a one-bullet to the "Applied Learning Architecture" section. Keep each bullet under 30 words. Minimal explanations. Do not overwrite past logs; append to them.
