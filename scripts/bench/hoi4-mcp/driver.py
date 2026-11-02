"""Head-to-head run of hoi4-agent-tools and cpntodd/HOI4-MCP (decision M-7). Project tooling.

Runs inside the container built by scripts/bench/hoi4-mcp/Dockerfile, with no network, the
game and mods mounted read-only and /out writable. Both servers are driven over MCP stdio by
the same client with the same inputs; the expected answers are in tasks.json. Writes
/out/results.json.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

OUT = Path("/out")
GAME = Path("/game")
MODS = Path("/user/mod")
LOG = Path("/user/logs/error.log")
TASKS = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))


def text_of(result: Any) -> str:
    return "".join(getattr(item, "text", "") for item in result.content)


def structured_of(result: Any) -> dict[str, Any]:
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        return structured
    try:
        parsed = json.loads(text_of(result))
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except ValueError:
        return {"text": text_of(result)}


class Server:
    def __init__(self, name: str, params: StdioServerParameters) -> None:
        self.name = name
        self.params = params

    async def __aenter__(self) -> "Server":
        self._client = stdio_client(self.params)
        read, write = await self._client.__aenter__()
        self._session = ClientSession(read, write)
        await self._session.__aenter__()
        await self._session.initialize()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._session.__aexit__(*args)
        await self._client.__aexit__(*args)

    async def call(self, tool: str, arguments: dict[str, Any]) -> tuple[dict[str, Any], str, float]:
        started = time.perf_counter()
        result = await self._session.call_tool(tool, arguments)
        elapsed = (time.perf_counter() - started) * 1000
        return structured_of(result), text_of(result), elapsed


def ours(workspaces: list[dict[str, Any]]) -> StdioServerParameters:
    state = OUT / "ours"
    state.mkdir(parents=True, exist_ok=True)
    config = state / "config.json"
    config.write_text(
        json.dumps(
            {
                "version": 1,
                "serverStateRoot": str(state / "state"),
                "workspaceStorageRoot": str(state / "workspaces"),
                "gameUserRoot": "/user",
                "workspaces": workspaces,
            }
        ),
        encoding="utf-8",
    )
    return StdioServerParameters(
        command="node",
        args=["/opt/hoi4-agent-tools/dist/bin/stdio.js"],
        env={**os.environ, "HOI4_AGENT_CONFIG": str(config)},
    )


def theirs(mod: Path) -> StdioServerParameters:
    return StdioServerParameters(
        command="/opt/hoi4-mcp/bin/hoi4-mcp",
        args=[
            "--mod-path",
            str(mod),
            "--vanilla-path",
            str(GAME),
            "--vanilla-db",
            str(OUT / "theirs" / "vanilla.db"),
            "--error-log-path",
            str(LOG),
        ],
        env={**os.environ, "HOME": str(OUT / "theirs")},
    )


def seeded_mod() -> Path:
    root = OUT / "seeded_mod"
    (root / "events").mkdir(parents=True, exist_ok=True)
    (root / "descriptor.mod").write_text('name="Seeded errors"\n', encoding="utf-8")
    for case in TASKS["seeded"]:
        (root / "events" / f"{case['id']}.txt").write_text(case["text"], encoding="utf-8")
    return root


def highest_event_id(namespace: str) -> int:
    pattern = re.compile(rf"\bid\s*=\s*{re.escape(namespace)}\.(\d+)\b")
    highest = 0
    for root in (MODS / "chaos_redux" / "events", GAME / "events"):
        for file in root.rglob("*.txt"):
            for match in pattern.finditer(file.read_text(encoding="utf-8", errors="replace")):
                highest = max(highest, int(match.group(1)))
    return highest


async def run() -> dict[str, Any]:
    results: dict[str, Any] = {"ours": {}, "theirs": {}}
    seeded = seeded_mod()
    empty = OUT / "vanilla_mod"
    empty.mkdir(parents=True, exist_ok=True)
    (empty / "descriptor.mod").write_text('name="Vanilla"\n', encoding="utf-8")
    (OUT / "theirs").mkdir(parents=True, exist_ok=True)

    # Vanilla database of HOI4-MCP: built once, timed.
    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        "/opt/hoi4-mcp/bin/index-vanilla",
        "--vanilla-path",
        str(GAME),
        "--db-path",
        str(OUT / "theirs" / "vanilla.db"),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await proc.communicate()
    results["theirs"]["vanilla_index"] = {
        "exitCode": proc.returncode,
        "ms": round((time.perf_counter() - started) * 1000),
        "output": output.decode("utf-8", "replace")[-2000:],
    }

    workspaces = [
        {"id": "chaos_redux", "name": "Chaos Redux", "root": str(MODS / "chaos_redux"), "gameRoot": str(GAME)},
        {"id": "vanilla", "name": "Vanilla", "root": str(empty), "gameRoot": str(GAME)},
        {"id": "seeded", "name": "Seeded", "root": str(seeded), "gameRoot": str(GAME)},
    ]

    # 1. Cold index of Chaos Redux, then warm repeats.
    async with Server("ours", ours(workspaces)) as server:
        timings = []
        for _ in range(6):
            data, _, ms = await server.call("hoi4.mod_index", {"workspaceId": "chaos_redux", "mode": "overview"})
            timings.append(ms)
        results["ours"]["index"] = {"coldMs": round(timings[0]), "warmMedianMs": round(statistics.median(timings[1:])), "status": data.get("status")}

        # 2. Known-good files: validation errors are false positives.
        known: dict[str, Any] = {}
        for corpus, files in TASKS["knownGood"].items():
            errors = 0
            flagged = 0
            for relative in files:
                data, _, _ = await server.call(
                    "hoi4.script_validate", {"workspaceId": "vanilla" if corpus == "vanilla" else corpus, "path": relative, "limit": 32}
                )
                count = sum(1 for f in data.get("data", {}).get("findings", []) if f.get("status") == "error")
                errors += count
                flagged += 1 if count else 0
            known[corpus] = {"files": len(files), "filesFlagged": flagged, "errors": errors}
        results["ours"]["knownGood"] = known

        # 3. Seeded errors: each file has exactly one real error, or none for the controls.
        seeded_results = []
        for case in TASKS["seeded"]:
            data, text, _ = await server.call("hoi4.script_validate", {"workspaceId": "seeded", "path": f"events/{case['id']}.txt", "limit": 32})
            findings = data.get("data", {}).get("findings", [])
            flagged = data.get("status") != "ok" or any(f.get("status") == "error" for f in findings)
            seeded_results.append({"id": case["id"], "expected": case["hasError"], "flagged": flagged})
        results["ours"]["seeded"] = seeded_results

        # 4. Next free event id.
        next_ids = []
        for namespace in TASKS["namespaces"]:
            data, _, _ = await server.call("hoi4.mod_index", {"workspaceId": "chaos_redux", "mode": "next_id", "kind": "event", "namespace": namespace})
            next_ids.append({"namespace": namespace, "answer": data.get("data", {}).get("next", {}).get("nextId")})
        results["ours"]["nextId"] = next_ids

        # 5. Exact vanilla definitions.
        lookups = []
        for item in TASKS["vanillaLookups"]:
            data, _, ms = await server.call("hoi4.source_lookup", {"workspaceId": "vanilla", "symbol": item["id"], "includeReferences": False})
            definitions = data.get("data", {}).get("definitions", [])
            path = definitions[0].get("path", "") if definitions else ""
            lookups.append({"id": item["id"], "answer": path, "ms": round(ms)})
        results["ours"]["vanillaLookups"] = lookups

        # 6. Command documentation.
        docs = []
        for name in TASKS["commands"]:
            data, _, _ = await server.call("hoi4.reference_search", {"workspaceId": "vanilla", "query": name})
            hits = data.get("data", {}).get("results", [])
            docs.append({"command": name, "firstHeading": hits[0].get("heading") if hits else None})
        results["ours"]["commands"] = docs

        # 7. Error log of a launch that did not load Chaos Redux.
        data, text, _ = await server.call("hoi4.error_log", {"workspaceId": "chaos_redux", "scope": "mod"})
        results["ours"]["errorLog"] = {"text": text[:600], "modEntries": data.get("data", {}).get("modEntries")}

    async with Server("theirs", theirs(MODS / "chaos_redux")) as server:
        timings = []
        for index in range(6):
            data, text, ms = await server.call("get_mod_index", {"summary_only": True, "refresh": index == 0})
            timings.append(ms)
        results["theirs"]["index"] = {"coldMs": round(timings[0]), "warmMedianMs": round(statistics.median(timings[1:])), "sample": text[:300]}

        known = {}
        for corpus, files in TASKS["knownGood"].items():
            base = GAME if corpus == "vanilla" else MODS / corpus
            errors = 0
            flagged = 0
            for relative in files:
                content = (base / relative).read_text(encoding="utf-8-sig", errors="replace")
                data, _, _ = await server.call("validate_syntax", {"text": content, "file_type": "clausewitz"})
                count = int(data.get("error_count", 0) or 0)
                errors += count
                flagged += 1 if count else 0
            known[corpus] = {"files": len(files), "filesFlagged": flagged, "errors": errors}
        results["theirs"]["knownGood"] = known

        seeded_results = []
        for case in TASKS["seeded"]:
            data, _, _ = await server.call("validate_syntax", {"text": case["text"], "file_type": "clausewitz"})
            flagged = int(data.get("error_count", 0) or 0) > 0
            seeded_results.append({"id": case["id"], "expected": case["hasError"], "flagged": flagged})
        results["theirs"]["seeded"] = seeded_results

        next_ids = []
        for namespace in TASKS["namespaces"]:
            data, _, _ = await server.call("get_next_id", {"id_type": "event", "namespace": namespace})
            next_ids.append({"namespace": namespace, "answer": data.get("suggested")})
        results["theirs"]["nextId"] = next_ids

        lookups = []
        for item in TASKS["vanillaLookups"]:
            data, text, ms = await server.call("lookup_vanilla", {"query_type": item["type"], "query": item["id"]})
            lookups.append({"id": item["id"], "answer": text[:400], "ms": round(ms)})
        results["theirs"]["vanillaLookups"] = lookups

        tools = await server._session.list_tools()
        results["theirs"]["commands"] = {
            "note": "HOI4-MCP has no effect or trigger documentation lookup",
            "tools": sorted(tool.name for tool in tools.tools),
        }

        data, text, _ = await server.call("get_latest_errors", {"log_path": str(LOG), "tail_lines": 200})
        results["theirs"]["errorLog"] = {"text": text[:600]}

    results["truth"] = {
        "nextId": [{"namespace": ns, "answer": f"{ns}.{highest_event_id(ns) + 1}"} for ns in TASKS["namespaces"]],
        "vanillaLookups": TASKS["vanillaLookups"],
        "commands": TASKS["commands"],
        "seeded": [{"id": case["id"], "hasError": case["hasError"], "why": case["why"]} for case in TASKS["seeded"]],
    }
    return results


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(asyncio.run(run()), indent=2), encoding="utf-8")
    print("wrote /out/results.json")
