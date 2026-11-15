# Runtime observation

On 2026-11-09, the installed Silico app was selected through the computer-use
API, and its accessibility tree and screenshot were read. No click, typing,
message submission, setting change, or lab start/stop action was performed.

The current window contained an authenticated research workspace under a hosted
`*.runtime.silico.run/workspace/.../new` URL. Personal account, workspace and
existing thread identifiers are omitted from this report and reconstruction.
This corroborates the static conclusion that the main research UI is hosted,
rather than implemented by the packaged connection-manager renderer.

Observed initial-screen elements:

- A slim native/top chrome and a roughly 218 px sidebar.
- Silico branding, New thread, Reports, thread search/list, folder controls,
  collapse control and account footer.
- A centered serif research heading and large composer.
- Attachment/code/model picker, Auto-research switch, model picker showing
  GPT-6 Astra, dictation and send controls.
- Codebase/folder selectors and three suggested starting prompts.
- White surfaces, dark gray text, subtle borders and an orange accent.

Only appearance, accessibility labels and current URL were observed. Model
availability, billing, real research execution, reports, attachment handling,
folder operations and persistence were not tested on the original service.
The initial local preview used synthetic identity and browser-local simulations.
It is retained only as a legacy preview. The default app now uses recovered hosted
assets and a real local executor; see [validation](validation.md).

During the hosted follow-through on 2026-11-10 UTC, read-only UI navigation also
inspected the model role picker, source menus, Reports inventory, and an existing
thread's experiment Report/Timeline/Worker/Code surfaces. Planner and Worker
were separate roles; plan approval, independent experiment progress, artifact
viewing and report publication controls were visible. Existing private research
content was not copied into this report. No message, experiment, provider change,
or publication was submitted to the original service. The local model runs
listed in validation used only synthetic test data and deliberately selected
public sources.
