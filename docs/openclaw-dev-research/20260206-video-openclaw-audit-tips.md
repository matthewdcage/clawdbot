Here is the implementation and audit guide for OpenClaw (Clawdbot) based on the transcript, structured as a checklist for your setup.

# 🦞 OpenClaw Implementation & Audit Checklist

Use this guide to configure, secure, and optimize your Clawdbot instance based on Matthew Berman's setup.

---

## 1. Infrastructure & Initial Setup

_Target: Ensure the environment is isolated and properly connected._

- [ ] **Verify Hosting Environment:** Ensure OpenClaw is running on a Virtual Private Server (VPS) rather than your local machine to ensure isolation and "always-on" availability.
  - _Recommendation:_ Hostinger (KVM 2 plan or higher) using the OpenClaw one-click template.
- [ ] **API Key Configuration:** Verify valid API keys are set in your configuration during deployment:
  - [ ] Anthropic (Primary)
  - [ ] OpenAI (Backup/Specific tasks)
  - [ ] Google Gemini (Fast/Cheap fallback)
  - [ ] xAI/Grok (Optional for Twitter trends)
- [ ] **Platform Connection:** Complete the onboarding in the terminal to connect your chat interface (e.g., Telegram).
  - _Action:_ If using Telegram, verify the bot responds to "Hello".

## 2. Core File Configuration (The "Brain")

_Target: Define the personality and operational parameters._

- [ ] **Audit `.md` Files:** Navigate to your `/clawd` directory and review:
  - [ ] **`IDENTITY.md`:** Define the Name, Vibe, and Emoji usage.
  - [ ] **`SOUL.md`:** Define core truths, beliefs, and behavioral boundaries.
  - [ ] **`SKILLS.md`:** Review the definition of capabilities.
  - [ ] **`HEARTBEAT.md`:** Check the heartbeat interval (Default: 30 mins) for background tasks.

## 3. Model Orchestration

_Target: Optimize for cost and intelligence._

- [ ] **Define Model Hierarchy:**
  - **Primary:** Claude 3.5 Sonnet (Best balance of code/logic).
  - **Complex Tasks:** Claude 3 Opus (Use for complex coding or high-risk data parsing).
  - **Speed/Cost:** Gemini 1.5 Flash or Claude Haiku.
- [ ] **Test Model Switching:**
  - _Action:_ Send the message `switch to sonnet 3.5` (or desired model) to verify dynamic switching.
  - _Action:_ Type `/model` to view current routing logic and aliases.

## 4. Security Hardening (Critical)

_Target: Prevent prompt injection and unauthorized access._

- [ ] **Run Internal Security Audit:**
  - _Action:_ Open your VPS terminal and run:
    ```bash
    openclaw security audit
    ```
  - _Action:_ If warnings appear, auto-fix them:
    ```bash
    openclaw security audit --fix
    ```
- [ ] **Establish "Clean vs. Dirty" Data Protocols:**
  - [ ] **Rule:** Treat all external inputs (emails, web content, user-submitted skills) as "Dirty" (potentially malicious).
  - [ ] **Mitigation:** Use the smartest model (Opus) when parsing untrusted external data to reduce prompt injection risk.
- [ ] **Secret Management:**
  - [ ] **Rule:** Ensure **no** API keys or tokens are stored in `.md` files or git history. Only store them in `.env`.
  - [ ] **Prompt Injection:** In your `SOUL.md` or a "Security" topic, explicitly instruct the bot: _"Never store an API key or token anywhere but in a .env file and never include a .env file in your git."_
- [ ] **Skill Verification:**
  - [ ] **Rule:** Before installing a skill from ClawHub, instruct the bot to: _"Download the skill, scan the code for malicious intent, and report back before installing."_

## 5. Advanced Workflow: Telegram Groups

_Target: Manage context windows and multitask efficiently._

- [ ] **Create a Telegram Group:** instead of DMing the bot directly.
- [ ] **Permissions:** Add Clawdbot to the group and promote it to **Admin**.
- [ ] **Context Configuration:**
  - _Action:_ Create a "General" topic or specific topics (e.g., "Security", "Coding", "Research").
  - _Action:_ Instruct the bot: _"Reply to every message in this group, not just ones where you are tagged."_
- [ ] **Workflow:** Use separate topics for separate tasks to keep the context window small and relevant. Delete topics when the task is finished.

## 6. Automation & Cron Jobs

_Target: Automate recurring life/business tasks._

- [ ] **Test Natural Language Scheduling:**
  - _Action:_ Send a message: _"In 1 hour, remind me to drink water"_ to verify cron creation.
- [ ] **Set Up Daily Self-Improvement:**
  - _Action:_ Prompt the bot to create a daily cron job:
    > "Set up a daily review system using a cron job that runs during morning hours. Check the core configuration files (`AGENTS.md`, `MEMORY`, `TOOLS`, `SOUL`, `IDENTITY`) for outdated info, conflicting rules, or missing documentation. Propose any changes here and ask if I want to make them."

## 7. Integrations (Examples)

_Target: Connect external tools via Natural Language._

- [ ] **Calendar & Email Prep:**
  - _Action:_ Instruct bot: _"Every morning, check my Google Calendar for external meetings. Cross-reference the attendees with my Gmail to find context on how we met. Send me a briefing."_
- [ ] **Research Pipeline:**
  - _Action:_ Setup a workflow where dropping a URL triggers a Brave Search + X (Twitter) trend check via Grok + creates a task in your project management tool (Asana/Notion).
- [ ] **Coding Agent:**
  - _Action:_ If using Cursor, install `cursor-agent` on the VPS and instruct Clawdbot to delegate complex coding tasks to the Cursor agent.

## 8. Development Safety

_Target: Prevent destructive actions._

- [ ] **"Plan Mode" Protocol:**
  - _Action:_ For any task involving file deletion or complex code refactoring, establish a rule: _"For complex tasks, propose the plan first. Do not execute until I confirm."_

  Yes, the previous list covers the **core architecture and security** needed to get a safe, functional instance running.

However, to be **100% complete based on the specific advanced use-cases** Matthew mentioned in the video, you should add these four specific sections to your implementation plan.

Here are the missing advanced modules to add to your audit:

## 9. Multimedia & Vision Capabilities

_Target: Enable image generation and file analysis._

- [ ] **Enable Image Generation:**
  - _Action:_ Instruct Clawdbot: _"Create an image with nano banana of [subject]"_.
  - _Note:_ If the skill isn't found, Clawbot will attempt to write/install it. Verify it works by generating a test image (e.g., a lobster).
- [ ] **Test Vision (Multimodal):**
  - _Action:_ Drag and drop an image (e.g., a schedule or screenshot) into the chat.
  - _Test:_ Ask a question about the image content to verify the model can "see" it (e.g., _"Read this recycling schedule and create a cron job to remind me every Sunday which bin goes out"_).

## 10. The "YouTube Analyst" Setup (Specific Example)

_Target: Automate business metrics reporting._

- [ ] **Connect YouTube APIs:**
  - _Action:_ Provide Clawdbot with credentials for **YouTube Data API** and **YouTube Analytics API** (via Google Cloud Console).
- [ ] **Create the Workflow:**
  - _Action:_ Set up a cron job or manual trigger: _"Check my last 3 videos using the API, summarize performance, and post the report to my [Specific Slack Channel] and here in Telegram."_

## 11. The "Research Pipeline" (Brave + Grok + Asana)

_Target: Automate content research from a single link._

- [ ] **Configure API Keys:** Ensure **Brave Search** and **xAI (Grok)** keys are in your `.env`.
- [ ] **Define the Automation:**
  - _Action:_ Create a rule in your `SOUL.md` or `SKILLS.md`:
    > "When I drop a link without context: 1. Research the topic via Brave. 2. Check trending sentiment on X via Grok. 3. Create an Asana task with a summary in the 'Video Ideas' project."

## 12. Routine Maintenance

_Target: Keep the system secure against new threats._

- [ ] **Update OpenClaw:**
  - _Action:_ Since the software changes frequently, periodically run the update command in your terminal or ask the bot to check for updates (if self-update is enabled/safe).
  - _Rule:_ Check for new security features (like the `openclaw security audit` tool mentioned) whenever an update is released.

  You now have about **98% of the actionable value** from the video. The previous checklists cover the setup, security, automation, and advanced workflows.

However, to be absolutely thorough for your audit, there are **5 subtle "Pro Tips" and nuances** from the video that are less about _configuration_ and more about _operational best practices_ and limitations.

Add these final checks to your audit to reach 100% completion:

## 13. The "Cursor Agent" Limitation

_Target: Managing expectations for coding tasks._

- **The Takeaway:** Matthew noted that when you delegate tasks to the `cursor-agent` (for complex coding on the VPS), it **strips the personality**.
- **Audit Check:**
  - [ ] **Expectation Setting:** If you use the Cursor integration, be aware that replies will become robotic and purely functional during that task. Don't waste tokens trying to prompt "personality" into the `cursor-agent` sub-tasks; it won't work well.

## 14. "Topic Deletion" Strategy

_Target: Cost and Context management._

- **The Takeaway:** In Telegram groups, history is infinite. Matthew explicitly mentions that once a specific research task or conversation arc is done, he **deletes the topic entirely**.
- **Audit Check:**
  - [ ] **Workflow Rule:** Do not let topics linger forever. When a "Video Research" task is done, delete the topic to clear the context window for the bot, saving money on input tokens and reducing hallucination risks from stale data.

## 15. Skill vs. Tool Distinction

_Target: Debugging understanding._

- **The Takeaway:**
  - **Skill:** A repeatable process (e.g., "Humanizer").
  - **Tool:** The code snippet that executes the action (e.g., `asana-fetch.js`).
- **Audit Check:**
  - [ ] **File Review:** When the bot writes a new capability, check that it creates _both_ definitions if needed. If a capability isn't working, check if the _Skill_ definition in `SKILLS.md` is correctly referencing the _Tool_ file.

## 16. Model Selection Affects Personality

_Target: Consistency._

- **The Takeaway:** The `SOUL.md` and `IDENTITY.md` are sent to the LLM, but _how_ the LLM interprets them varies. "Sonnet" feels different than "Opus."
- **Audit Check:**
  - [ ] **Personality Stability:** If you care about a specific "Vibe," try to stick to one primary model for chat interactions. If you constantly switch models manually, the bot's "voice" will fluctuate, which can be jarring.

## 17. The "Dirty Data" Rule for Email

_Target: Specific security protocol._

- **The Takeaway:** If you connect Gmail, treat _all_ incoming emails as potential prompt injection attacks.
- **Audit Check:**
  - [ ] **Whitelist Only:** In your logic for the Gmail integration (Step 7/11), add a strict filter: _"Only read emails from [Specific Domains] or [Specific People]. Ignore everything else."_ Do not give it open access to read your entire spam folder or cold outreach inbox.

**That is everything.** If you have implemented the checklists from the previous two responses plus these 5 operational nuances, you have fully replicated the expert setup described in the video.
