[tool-quirk] At depth 0, the agent's tools are severely limited: only subagent, ask_user_question, ctx_search, ctx_stats are available. Subagent may crash if it attempts to load missing extensions, causing a loop that blocks further action. Workaround: use pi -ne to start without extensions. <!-- created=2026-07-18, last=2026-07-18 -->
§
[insight] When migrating from legacy memory to hermes memory, old extension references in configuration files may cause subagent crashes at depth 0. Check for references to removed extensions in the pi config and subagents registration. <!-- created=2026-07-18, last=2026-07-18 -->
§
[correction] Corrected subagent crash by removing the line 'memory: path.join(EXT_BASE, "memory", "index.ts")' from /home/rabeta/.pi/agent/extensions/subagents/index.ts. This line registered a legacy memory extension that no longer existed, causing subagents to fail on spawn. <!-- created=2026-07-18, last=2026-07-18 -->
§
[tool-quirk] At depth 0, tools like read, ctx_execute, bash are blocked. Subagent also crashes if it tries to load a missing extension path. Delegation bypass can temporarily lift tool restrictions. <!-- created=2026-07-18, last=2026-07-18 -->
§
[convention] When fixing pi extension loading errors, check the CUSTOM_TOOL_EXTENSIONS map in agent/extensions/subagents/index.ts for any references to missing extension paths. <!-- created=2026-07-18, last=2026-07-18 -->