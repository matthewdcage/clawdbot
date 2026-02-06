Here is the transcript transformed into a structured **Implementation & Audit Checklist** based on the advice given for "Clawbot" (OpenClaw/OpenInterpreter).

You can use this markdown document to audit your current installation and workflow.

***

# 🤖 OpenClaw / Clawbot Optimization Checklist

## Phase 1: Configuration & Memory
*Objective: Fix memory loss during context window compaction to ensure long-term retention.*

### 1. Enable Advanced Memory Settings
The video identifies two critical settings often disabled by default that cause the bot to "forget" recent interactions after memory compaction.

- [ ] **Audit:** Check if `memory_flush` and `session_memory_search` are enabled in your configuration.
- [ ] **Action:** Run the following prompt to update the config dynamically:

```text
Enable memory flush before compaction and session memory search in my Clawbot config. 
Set 'compaction.memoryFlush.enabled' to true and set 'memorySearch.experimental.sessionMemory' to true with sources including BOTH memory and sessions. 
Apply the config changes.
```

## Phase 2: Model Architecture ("Brain & Muscles")
*Objective: optimize cost and speed by delegating tasks to specialized models rather than using Opus for everything.*

### 2. Configure Model Delegation
Treat **Claude 3 Opus** as the "Brain" (logic/orchestration) and other models as "Muscles" (specific execution).

- [ ] **Audit:** Are you using Opus for web searches or simple coding tasks?
- [ ] **Action:** Configure the following specific model overrides (requires API keys):
    *   **Coding/CLI:** Switch to **Codex** (or potentially Sonnet/DeepSeek depending on your preference, though video suggests Codex).
    *   **Web Search:** Switch to **Gemini API**.
    *   **Social Search:** Switch to **Grok API**.

**Prompt to implement:**
```text
Moving forward, I want to use specific muscles for specific tasks (these are just examples, I want to configure my own routing)
1. Use Codex CLI for all coding tasks.
2. Use the Gemini API for all web search tasks.
3. Use the Grok API for all social search tasks.
Please walk me through the setup and ask for the necessary API keys now.
```

## Phase 3: Context & Behavior ("The Employee Mindset")
*Objective: Move from a "Chatbot" relationship to an "Employee" relationship by establishing deep context.*

### 3. The "Brain Dump"
- [ ] **Action:** Spend 10 minutes writing a prompt that details:
    *   Your long-term ambitions and goals.
    *   Your daily habits and workflow.
    *   Personal interests/hobbies.
    *   Current project context.
    *   *Why:* This ensures the bot's autonomous decisions align with your personality.

### 4. Expectation Setting (Proactive Mode)
- [ ] **Action:** Explicitly authorize and instruct the bot to work autonomously while you sleep.

**Prompt to implement:**
```text
I want to set expectations for our working relationship:
1. Be proactive.
2. I authorize you to work overnight while I sleep.
3. Your goal is to have me wake up to a surprise or completed work that gets me closer to my goals every morning.
```

## Phase 4: Advanced Workflow
*Objective: Utilize the AI's intelligence to direct the workflow, rather than micromanaging it.*

### 5. Reverse Prompting
Instead of thinking of tasks yourself, force the AI to generate its own scope of work based on the context you provided in Phase 3.

- [ ] **Action:** Use the following Reverse Prompts periodically:

**Option A (Task Generation):**
```text
Based on what you know about me and my goals, what are some tasks you can do right now to get us closer to our missions?
```

**Option B (Productivity Audit):**
```text
What other information can I provide you to improve our productivity?
```

## Phase 5: Self-Building Infrastructure ("Vibe Coding")
*Objective: Have the AI build the UI/UX tools required to manage its own work.*

### 6. Build Custom Tooling
Don't just use the chat interface. Ask the bot to build visual interfaces (using its coding capabilities) to manage the workflow.

- [ ] **Action:** Ask the bot to build a specific tool to visualize its memory or tasks.

**Example Prompts:**
```text
Build a Kanban/Task board so I can track all the tasks you are currently working on, what is in the backlog, and what you have finished.
```
*OR*
```text
Build a document viewer that organizes all our past memories and tasks into readable documents.
```

Based on the transcript provided, the previous response actually covered the **5 Core Tips** promised in the video introduction.

However, to ensure your implementation plan is **complete** and captures the nuance of the *philosophy* and *maintenance* discussed in the final minutes of the video, here is the final phase of the audit.

This covers the "Soft Skills" and "Routine" advice extracted from the video's conclusion.

***

# 🤖 OpenClaw / Clawbot Optimization Checklist (Continued)

## Phase 6: Operational Philosophy & Maintenance
*Objective: Shift from a "Search Engine" user mindset to a "Manager" mindset to maintain the 100x performance gains.*

### 7. The "Employee Mindset" Audit
The video emphasizes that 99% of users fail because they treat Clawbot like a search engine (Input -> Output). You must treat it like a sovereign employee.

- [ ] **Audit:** Review your last 10 interactions.
    -   *Fail:* Did you only ask for facts or simple code snippets?
    -   *Pass:* Did you assign outcomes (e.g., "Figure out how to fix X," "Research Y and build a plan")?
- [ ] **Action:** Every night before you sleep, verify you have assigned an "Overnight Mission."
    -   *Example:* "I'm going to sleep. While I'm gone, investigate [Topic], build a prototype for [Feature], and have a report ready for me when I wake up."

### 8. Continuous Improvement Loop
Use the "Reverse Prompting" technique specifically for system maintenance, not just tasks.

- [ ] **Action (Weekly):** Run a "Performance Review" on your Clawbot using its own intelligence.
    -   **Prompt:** "Review our interaction history from the last week. Where did we waste tokens? What context are you missing about me that would have made your work faster? Update your memory files with this new context."

### 9. Verification of Installation
The video refers to "Clawbot aka OpenClaw." Ensure you are running the correct fork or configuration of Open Interpreter that supports these specific memory flags (`memory_flush`, `session_memory_search`).

- [ ] **Audit:** Ensure your `config.yaml` or startup arguments allow for the experimental memory features mentioned in Phase 1.
- [ ] **Action:** If the prompts in Phase 1 fail, check the OpenClaw/OpenInterpreter documentation for the specific syntax of `experimental` flags in the latest version, as these features are often hidden behind feature flags.

***

### Summary of Extracted Advice
1.  **Memory:** Enable `memory_flush` and `session_memory_search`.
2.  **Models:** Use Opus for Brain; Codex (Coding), Gemini (Web), Grok (Social) for Muscles.
3.  **Context:** Perform a massive "Brain Dump" of personal context.
4.  **Expectations:** Authorize proactive, overnight work.
5.  **Direction:** Use Reverse Prompting ("Tell me what you need").
6.  **Tooling:** Ask it to code its own dashboards (Kanban/Task boards).

*This concludes all actionable advice extracted from the provided transcript.*