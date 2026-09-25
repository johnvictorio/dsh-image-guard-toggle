# dsh-image-guard-toggle

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that puts an `image guard` capsule button in the top-right of the conversation header (beside the `response_end` capsule), toggling the `@deepseek-ai/dsh-llm-pi-ai` request image-size guard live, no restart. It also gives the model two tools (`list_images`, `drop_image`), blocks `read_image` calls that would cross the budget, and reports session image usage after every image read.

## Model-facing behavior

- `list_images` (no parameters): lists every image currently in the session's model-visible context, oldest first, as `id  approx  tool  file`, plus the session total and budget. The id is the session surface seq of the tool result carrying the image, stable across repeated lists. User-attached images count toward the total (the adapter replays them) but are reported as not droppable here.
- `drop_image` (parameters: `ids`, integers from list_images): rewrites each listed tool result in place, replacing only its image blocks with a one-line marker naming the approximate KB and the re-read option. The text half of the result survives, the append-only log keeps the originals, and the drop is permanent for every later turn, unlike the adapter's own oldest-first per-request offload which recomputes each time. Unknown or already-dropped ids come back as `unknown ids`, never an error. The result ends with the fresh usage line.
- Each replacement is preceded by a `compaction/prune` shadow-price event (when the token meter is mounted), the same protocol `dsh-compaction-tool-result-pruner` uses, so request-pressure accounting stays truthful.
- `tools/pre-execute` denies a `read_image` call when current session image bytes plus the incoming file's capped estimate (`min(size, 1 MiB) * 4/3`, matching what the adapter can put on the wire) would exceed the budget. The denial names usage, budget, and the list/drop path. Guard off or unstatutable path: the read proceeds. Paths are measured through the harness `fs` seam against the session cwd, so relative paths refer to the same file the tool reads.
- `tools/post-execute` appends one line to every successful image read: `[image-guard] session image context: 5 images, about 6.40 MB of 8.00 MB used (80%).` and, from 80%, the nudge to list and drop before reading more.

## Settings behavior

- Registers the settings namespace `image-guard-toggle` (`enabled`, `budgetMb`, `route`).
- A server-side effect mirrors that preference onto the adapter's own `llm-pi-ai` settings namespace: when the toggle is on, it path-sets `providers.<route>.maxRequestImageBytes` to `budgetMb` MiB; when off, it path-unsets that field, returning the route to the adapter's own default (20 MiB, effectively no offload for typical sessions). The mirror only ever touches that one field: every path op leaves the other routes, models, and fields of the section exactly as they were.
- The adapter reads its profiles once per operation, so each mirrored change takes effect on the next LLM request, mid-session, with no restart.
- The button reads `image guard · 8 MB` (green dot) while the guard is active, with `off` appended (grey) when disabled. The dot and label toggle on/off; **click the number to type a new budget** (whole MB, 1-64; Enter or blur commits, Escape cancels; an invalid entry shows the reason in the tooltip and reverts). Each accepted budget re-mirrors `maxRequestImageBytes` onto the route, effective on the next request. The number stays editable while the guard is off, so you can change the budget before switching it back on.

### First-run adoption

If `image-guard-toggle` has no stored user section yet and the `llm-pi-ai` user section already carries an explicit `maxRequestImageBytes` for the configured route (e.g. a hand-edited `settings.yaml`), the plugin adopts that value into its own namespace instead of writing the default back over it. Hand-editing then toggling stays coherent.

## Install

```sh
cd /home/icly/dsh-image-guard-toggle
npm pack
dsh plugin --profile web add file:/home/icly/dsh-image-guard-toggle/dsh-image-guard-toggle-1.1.0.tgz
```

Then list the bundle in `~/.dsh/profiles/web/package.json` under `dsh.profile.bundles` and restart the profile (`dsh web`).

## Configuring

Section `image-guard-toggle` in `~/.dsh/settings.yaml`:

```yaml
image-guard-toggle:
  enabled: true
  budgetMb: 8
  route: hyper
```

`route` must name an existing provider route under `llm-pi-ai: providers:`; an unknown route is logged once and the toggle stays inert (nothing is written) until it exists.

## Uninstall

```sh
dsh plugin --profile web remove dsh-image-guard-toggle
```

Drop `dsh-image-guard-toggle` from `bundles` in `~/.dsh/profiles/web/package.json`, restart, and delete the `image-guard-toggle` section from `settings.yaml` if you want it clean. Removing the plugin does not remove the mirrored `maxRequestImageBytes` from `llm-pi-ai` (the file keeps whatever the last state was; edit it by hand to reset).
