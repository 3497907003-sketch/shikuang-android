"""Test-only initialization gate; no client access or lifecycle success inferred."""
from pathlib import Path
import hashlib
import json
import re

HELPER = "androidx.test.services"
OUTPUT = "androidx.test.services.storage.outputfiles"
COMPONENT = HELPER + "/.storage.provider.TestOutputFilesContentProvider"


def unique_section(text, start, end):
    assert text.count(start) == 1 and text.count(end) == 1, "Missing or ambiguous dump section"
    left = text.index(start) + len(start)
    right = text.index(end)
    assert right > left, "Unclosed or reordered dump section"
    return text[left:right]


def force_queryable_members(text):
    section = unique_section(text, "  queries via forceQueryable:\n  forceQueryable:\n", "  queries via package name:\n")
    assert section, "Empty forceQueryable set"
    members = set()
    for line in section.splitlines():
        assert line.startswith("    ") and not line.startswith("     "), "Unexpected forceQueryable row shape"
        row = line[4:]
        if row.startswith("[") and row.endswith("]"):
            items = row[1:-1].split(",")
        else:
            items = [row]
        assert items and all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", p) for p in items), "Invalid forceQueryable package name"
        members.update(items)
    assert HELPER in members, "Exact helper absent from forceQueryable set"
    return sorted(members)


def check_helper(package_dump, query_dump, install_stdout, appops):
    assert package_dump and query_dump and install_stdout and appops, "Empty helper evidence"
    assert package_dump.endswith("\n") and query_dump.endswith("\n"), "Truncated dump record"
    assert "\x00" not in package_dump + query_dump, "Invalid dump bytes"
    packages = unique_section(package_dump, "\nPackages:\n", "\nQueries:\n")
    blocks = list(re.finditer(r"(?ms)^  Package \[([^\]\n]+)\] \([a-f0-9]+\):\n(?P<body>.*?)(?=^  Package \[|\Z)", packages))
    helper = [p for p in blocks if p[1] == HELPER]
    assert len(helper) == 1, "Missing or ambiguous exact installed helper package"
    body = helper[0]["body"]
    assert len(re.findall(r"(?m)^    pkg=Package\{[a-f0-9]+ " + re.escape(HELPER) + r"\}$", body)) == 1, "Helper package object identity missing"
    flags = re.findall(r"(?m)^    forceQueryable=(true|false)(?: \(override=(true|false)\))?\s*$", body)
    assert len(flags) == 1 and flags[0][1] == "true", "Exact helper adb forceQueryable override is not true"
    users = re.findall(r"(?m)^    User 0: [^\n]*\binstalled=(true|false)\b[^\n]*$", body)
    assert users == ["true"], "Helper not unambiguously installed for User 0"
    authorities = unique_section(package_dump, "\nContentProvider Authorities:\n", "\nKey Set Manager:\n")
    provider = re.findall(r"(?m)^  \[" + re.escape(OUTPUT) + r"\]:\n    Provider\{([a-f0-9]+) " + re.escape(COMPONENT) + r"\}\n      applicationInfo=ApplicationInfo\{[a-f0-9]+ " + re.escape(HELPER) + r"\}\n", authorities)
    assert len(provider) == 1, "Output authority/component/application belongs to no unique helper"
    registered = unique_section(package_dump, "\nRegistered ContentProviders:\n", "\nContentProvider Authorities:\n")
    assert len(re.findall(r"(?m)^  " + re.escape(COMPONENT) + r":\n    Provider\{" + re.escape(provider[0]) + " " + re.escape(COMPONENT) + r"\}\n", registered)) == 1, "Output provider not registered as the same helper object"
    package_queries = unique_section(package_dump, "\nQueries:\n", "\nDexopt state:\n")
    package_members = force_queryable_members(package_queries)
    global_members = force_queryable_members(query_dump)
    assert len(re.findall(r"(?m)^Success[ \t]*$", install_stdout)) == 1, "Helper install did not unambiguously report Success"
    assert re.fullmatch(r"MANAGE_EXTERNAL_STORAGE: allow(?:; time=\+(?=[0-9])(?:[0-9]+d)?(?:[0-9]+h)?(?:[0-9]+m)?(?:[0-9]+s)?(?:[0-9]+ms)? ago)?\s*", appops), "Helper storage appop is not allowed"
    return {"exact_helper": HELPER, "manifest_force_queryable": flags[0][0] == "true", "adb_override": True,
            "package_set_member": HELPER in package_members, "global_set_member": HELPER in global_members,
            "output_authority": OUTPUT, "output_component": COMPONENT, "helper_user0_installed": True,
            "client_provider_access_proven": False, "lifecycle_pass": False}


def verify_files(base):
    paths = {key: base / name for key, name in {"package_dump": "helper-package-visibility.txt",
             "query_dump": "helper-package-queries.txt", "install_stdout": "helper-install-stdout.txt",
             "appops": "helper-storage-appops.txt"}.items()}
    raw = {key: path.read_bytes() for key, path in paths.items()}
    commands = {}
    for key, argv in [("package_dump", ["adb", "shell", "dumpsys", "package", HELPER]),
                      ("query_dump", ["adb", "shell", "dumpsys", "package", "queries"])]:
        stem = paths[key].stem
        rc_file = base / (stem + "-returncode.txt")
        stderr_file = base / (stem + "-stderr.bin")
        rc, stderr = rc_file.read_bytes(), stderr_file.read_bytes()
        assert rc == b"0\n", "Helper dump command did not complete successfully: " + stem
        commands[key] = {"argv": argv, "timeout_seconds": 30, "returncode": 0,
            "stdout": {"file": paths[key].name, "bytes": len(raw[key]), "sha256": hashlib.sha256(raw[key]).hexdigest()},
            "stderr": {"file": stderr_file.name, "bytes": len(stderr), "sha256": hashlib.sha256(stderr).hexdigest()},
            "returncode_record": {"file": rc_file.name, "bytes": len(rc), "sha256": hashlib.sha256(rc).hexdigest()}}
    result = check_helper(**{key: value.decode("utf-8", errors="strict") for key, value in raw.items()})
    result["raw_evidence"] = {key: {"file": path.name, "bytes": len(raw[key]), "sha256": hashlib.sha256(raw[key]).hexdigest()} for key, path in paths.items()}
    result["dump_commands"] = commands
    (base / "helper-initialization-gate.json").write_text(json.dumps(result, indent=2) + "\n")
    return result

