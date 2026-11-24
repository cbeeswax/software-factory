# Factory inbox

Drop a Markdown file here to hand the factory an idea without opening GitHub. The first line is the title; the rest is the description.

`/factory collect` (or `node factory/bin/collect.mjs`) turns each file into a GitHub issue labelled `factory:triage` and moves the file to `done/`. Add the `factory` label to an issue when you want it built.

The collector skips this file because of its name, so do not name an idea `README.md`.
