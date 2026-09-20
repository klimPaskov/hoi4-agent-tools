# Synthetic GUI acceptance fixture

Everything under this directory is project-owned and generated specifically for the
HOI4 Agent Tools test suite. It contains no installed-game or third-party mod content.

The workspace exercises the real Scripted GUI Studio source graph, scenario resolver,
layout engine, renderer, validators, and shared content-addressed artifact store. The
baseline contains five tabs, twelve cards, scripted meters and text values, a clipped
dynamic list, tooltips, long localisation, BMFont metrics, a confirmation modal, and a
six-frame animation with a static fallback. Dynamic list expansion takes the visible
scene above 150 elements.

The 1500-by-900 authored window uses explicit UI scale 0.5 in the compact 960-by-540 baseline.
Resolution changes do not scale authored coordinates implicitly.
The resolution matrix also covers scale 0.6 at 1280 by 720 and native scale 1.0 at 1920 by 1080.
Panels, cards and the modal use declared cornered-tile sprites; the scene retains their 14 independent background layers alongside the original 203 visible elements.
Set `HOI4_GUI_ACCEPTANCE_OUTPUT` to a local directory to inspect the acceptance image, layout and diagnostics before reviewing a golden update.

`workspace/hoi4_agent/animation_sources/synthetic_pulse/` preserves the scanned v1 manifest and six independently-authored vector frames. Run
`npm run fixtures:generate:gui` from the repository root to reproduce the
checked-in PNG textures. Acceptance tests never run this generator and never spawn,
launch, automate, or inspect a game process.

`invalid/defect-variants.json` describes deterministic scenario and source mutations.
The tests apply those mutations only to temporary copies and send each copy through a
fresh WorkspaceResolver and ScriptedGuiStudio instance. The variants include a real
visible/click-region overlap in addition to state, clipping, script, and asset defects.
