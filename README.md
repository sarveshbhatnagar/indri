# Indri

A shared drawing workspace for developers and MCP agents. Ask an agent to explain code with a diagram or propose a rough UX sketch. Open the review link, comment on an element, then ask the agent to read the feedback and continue.

Agents share the `review_url` returned for the drawing they are working on, such as `http://127.0.0.1:4317/?diagram=...`. That page shows only that drawing, its comments and its version history, with no workspace navigation. Historical review links include `&revision=...` to open the requested version. The root URL is your separate drawing library. This controls the review experience; it does not add authentication or access restrictions.

## Install and run

Requires Node.js 22.13 or newer. Everything runs locally; no Aurkyon connection, hosted backend, account or model API key is needed. PM2 is included with the package.

```sh
npm install -g indri
indri
```

The command starts a background PM2 server and prints the review and MCP URLs. It tries port 4317 on first launch; if occupied, the operating system assigns an available port. Repeated `indri` calls reuse the same running instance. After a crash, PM2 restarts it on the remembered port when possible. If that port has been taken, check the new address with `indri status` and reconnect your MCP client.

The server survives closing your terminal and restarts after a crash. Diagrams, comments and all versions are stored in `~/.indri/indri.sqlite`, outside the installed package, so upgrading or reinstalling does not delete them. The current endpoint is recorded in `~/.indri/server.json`.

```sh
indri status
indri close
```

`indri close` stops only Indri, preserves your drawings, and clears its saved process entry so it will not return automatically. A later `indri` starts it again. Indri uses its own PM2 home at `~/.indri/pm2`; your other PM2 applications are unaffected. No global PM2 installation is needed. Logs are in `~/.indri/pm2/logs`.

On macOS, the default profile automatically installs a per-user login LaunchAgent at `~/Library/LaunchAgents/com.indri.local.plist`. It restores the saved server when you sign in after reboot. Linux/Windows and custom data directories currently need manual PM2 startup configuration for reboot persistence; the background service still survives terminal closure. To use an isolated profile, set `INDRI_DATA_DIR` before running the command.

After upgrading, use `indri close` then `indri` to load the new package. Actual reboot startup has not been hardware-tested. Automatic login startup references your Node and npm installation paths; run `indri` again if those paths change.

## Develop and release

```sh
npm ci
npm run build
node bin/indri.js
```

For the legacy checkout-only PM2 service, `npm run pm2:start` still uses `ecosystem.config.cjs` and `data/indri.sqlite`. That instance is separate from the npm CLI profile. To migrate data, stop the legacy process, back up the SQLite database into `~/.indri/indri.sqlite`, then run `indri`; retain the original until you verify the drawings.

`npm run demo` creates architecture and login examples through MCP; set `INDRI_URL` to the address printed by your CLI if it is not port 4317. Each run creates new examples.

```sh
npm test
npm run test:browser
npm run test:package
npm pack
npm publish --access public
```

The package ships prebuilt browser assets, a shrinkwrap and the tested PM2 dependency tree. Its publish allowlist excludes local databases, project tests, credentials and build tools. Licensing is currently `UNLICENSED` until a release license is selected.

## Connect an agent

For Codex CLI:

Use the MCP URL printed by `indri` or `indri status` in the following examples. Port 4317 is illustrative; use your actual port.

```sh
codex mcp add indri --url http://127.0.0.1:4317/mcp
```

Or add this to your Codex MCP configuration:

```toml
[mcp_servers.indri]
url = "http://127.0.0.1:4317/mcp"
```

For Claude Code:

```sh
claude mcp add --transport http indri http://127.0.0.1:4317/mcp
```

Other clients that support Streamable HTTP can use the same endpoint. Clients that only support stdio require a transport bridge. Restart/reconnect your agent after adding the server. Configuration formats are documented in [OpenAI's MCP documentation](https://developers.openai.com/codex/mcp/) and [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

Example requests:

> Explain the authentication flow in this repository using an Indri diagram. Add source file references to the nodes and share its review link.

> Draw a rough login screen sketch in Indri. Use a frame, email and password fields, a sign-in button, and a note about magic links.

> Read the open Indri comments for this diagram. Make the requested changes, update the drawing, explain your changes in the threads, and resolve addressed feedback.

Comments are persisted for the agent to read. They do not automatically start a sleeping agent; ask it to continue. The service needs no model API key: your existing agent supplies the reasoning and code tools.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_diagrams` | List drawings and open feedback counts |
| `create_diagram` | Create a diagram or sketch; return its review URL |
| `get_diagram` | Read the graph, current revision and discussion threads |
| `list_diagram_versions` | List graph versions; open one with `get_diagram` and `revision` |
| `update_diagram` | Replace the graph using `expected_revision` |
| `get_comments` | Read open/resolved/all feedback with graph context |
| `add_comment` | Start a thread on a diagram, node or edge |
| `reply_to_comment` | Add a reply to a thread |
| `set_comment_status` | Resolve or reopen feedback |
| `get_selection_context` | Retrieve objects within and around a rectangular area from any revision |

All writes validate their inputs. Diagram revisions use optimistic concurrency: read first, then pass the returned revision when updating or creating a comment. A stale write fails and leaves the data unchanged. Replies and thread status changes do not change the graph revision. SQLite transactions prevent one writer from dropping another reviewer's comments.

### Drawing format

`create_diagram` takes `{ "graph": ... }`. Diagrams use automatic graph layout:

```json
{
  "kind": "diagram",
  "title": "Request flow",
  "direction": "LR",
  "nodes": [
    { "id": "api", "label": "API", "source": { "path": "src/api.ts", "line": 42 } },
    { "id": "database", "label": "Database" }
  ],
  "edges": [
    { "id": "query", "source": "api", "target": "database", "label": "query" }
  ]
}
```

Use `kind: "sketch"` for positioned elements. `x` and `y` are the element's top-left coordinates; `width` and `height` set its size. Shapes are `box`, `ellipse`, `text`, `frame`, and `stroke`. Stroke `points` use local coordinates inside its bounds. Frames render behind other elements. See [examples/login-sketch.json](examples/login-sketch.json) for a complete low-fidelity wireframe and freehand annotation.

Keep IDs stable when changing a label, layout or explanation. Never reuse an ID for a different concept. Threads survive redraws; removing an element marks its thread as orphaned and retains its original label, creation revision and messages. Graph snapshots are also stored in SQLite for each revision. Source references are descriptive text, never executed or used to read arbitrary local files.

Feedback anchors look like `{ "type": "node", "id": "api" }`, `{ "type": "edge", "id": "query" }`, `{ "type": "diagram" }`, or `{ "type": "region", "x": 40, "y": 100, "width": 300, "height": 80 }`. Nodes and sketch elements share the same anchor format. A region with zero width and height is a point comment.

Dragging defaults to **Move view**, so you can move the drawing even when it is fitted to the canvas. Click **Select area**, then drag a screenshot-style rectangle or click a spot to comment. Selection works in either direction and accounts for pan, zoom and scrolling; it returns to Move view automatically after you select. **Fit** resets pan and scrolling to show the whole diagram. Numbered pins reopen area threads; Esc cancels selection and returns to Move view. Clicking an object and Tab/Enter/Space still select node/edge feedback. Historical versions can be moved and zoomed but remain read-only.

Each area comment includes an immutable `context` snapshot: the intersecting nodes and edges, plus up to five nearby nodes and three nearby edges, sorted by distance. Objects include their IDs, labels, descriptions, source references and drawing geometry; `selected` distinguishes intersections from surrounding objects. Selection uses object bounds and edge segments. Browser rendering and server retrieval share the same layout code.

Agents can read this directly with `get_comments`, or call `get_selection_context` with `{ "diagram_id": "...", "revision": 1, "target": { "type": "region", "x": 40, "y": 100, "width": 300, "height": 80 } }`. An older area comment is marked `outdated` after a redraw; its coordinates and captured context still refer to its original revision.

Use the version chooser above the canvas to open earlier drawings, including their area pins. Historical views are read-only. **Restore as new version** copies that drawing into a new current revision while preserving all intervening versions and threads. Agents can do the same by reading an older `get_diagram` revision, then passing that graph to `update_diagram` with the latest `expected_revision`.

The browser also supports replies, resolution/reopening, zoom, fitting and review updates every five seconds while forms are idle. It preserves unsaved comment drafts.

## Verify

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run test:package
npm run build
```

The integration check uses a real MCP client over HTTP and covers create → browser API comment → read → revise → reply → resolve, stale writes, persistence, sketch validation, area context, history restoration and host/origin protection. Browser tests check diagram/sketch selection, dragging at zoom while scrolled, nearby-object context, old-version pins, restore without history loss, keyboard access, comments/replies, resolution, text escaping, draft preservation and narrow layouts. Test databases are temporary or in memory.

## Local scope

This first version binds only to `127.0.0.1`, blocks unexpected Host/Origin headers and renders labels/comments as text. It is a single-owner workspace without authenticated identities: author names are self-reported and local processes can use the endpoint. Keep it local; a hosted version needs authentication and access control.

It supports low-fidelity SVG sketches and graph diagrams. Free-form human editing, raster mockups, hosted sharing, inline MCP Apps views and automatic agent wakeups are outside this version. MCP Apps can be added later while retaining the endpoint for clients without embedded UI support; [host support varies](https://modelcontextprotocol.io/extensions/apps/overview).

Dependency audit is clean. PM2 file watching is disabled; patched `basic-ftp`, `js-yaml` and `chokidar` resolutions are enforced by the published npm shrinkwrap as well as development overrides.
