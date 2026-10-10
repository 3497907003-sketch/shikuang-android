#!/usr/bin/env python3
"""Inspect packaged ELF contracts without executing native code.

ZIP alignment is additionally checked by the official SDK zipalign in CI.
This structural check never claims physical-device or 16 KB runtime validation.
"""
import argparse
import hashlib
import json
import struct
import zipfile
from pathlib import Path

ABIS = {"arm64-v8a", "armeabi-v7a", "x86", "x86_64"}
REQUIRED_LIBRARIES = {"libonnxruntime.so", "libonnxruntime4j_jni.so"}


def elf_segments(data):
    if len(data) < 64 or data[:4] != b"\x7fELF" or data[4] not in (1, 2) or data[5] not in (1, 2):
        raise ValueError("Invalid ELF header")
    bits = 64 if data[4] == 2 else 32
    order = "<" if data[5] == 1 else ">"
    if bits == 64:
        offset = struct.unpack_from(order + "Q", data, 32)[0]
        stride, count = struct.unpack_from(order + "HH", data, 54)
        fmt = order + "IIQQQQQQ"
    else:
        offset = struct.unpack_from(order + "I", data, 28)[0]
        stride, count = struct.unpack_from(order + "HH", data, 42)
        fmt = order + "IIIIIIII"
    if not 0 < count <= 256 or stride < struct.calcsize(fmt) or offset + stride * count > len(data):
        raise ValueError("Invalid ELF program-header bounds")
    segments = []
    for index in range(count):
        row = struct.unpack_from(fmt, data, offset + index * stride)
        kind = row[0]
        if bits == 64:
            file_offset, address, file_size, memory_size, alignment = row[2], row[3], row[5], row[6], row[7]
        else:
            file_offset, address, file_size, memory_size, alignment = row[1], row[2], row[4], row[5], row[7]
        if file_offset + file_size > len(data):
            raise ValueError("ELF segment extends beyond packaged bytes")
        if kind in (1, 0x6474E552):
            segments.append({"type": "LOAD" if kind == 1 else "GNU_RELRO", "offset": file_offset,
                             "virtualAddress": address, "memorySize": memory_size, "alignment": alignment})
    if not any(row["type"] == "LOAD" for row in segments):
        raise ValueError("ELF has no LOAD segments")
    return bits, segments


def inspect(path):
    rows = []
    failures = []
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            parts = entry.filename.split("/")
            if len(parts) != 3 or parts[0] != "lib" or not parts[2].endswith(".so"):
                continue
            if entry.file_size > 200 * 1024 * 1024:
                raise ValueError("Oversized native library")
            data = archive.read(entry)
            bits, segments = elf_segments(data)
            if parts[1] in ABIS and bits != (64 if parts[1] in {"arm64-v8a", "x86_64"} else 32):
                raise ValueError("Packaged ABI disagrees with ELF word size: " + entry.filename)
            compatible = True
            if parts[1] in {"arm64-v8a", "x86_64"}:
                for segment in segments:
                    if segment["type"] == "LOAD":
                        alignment = segment["alignment"]
                        if alignment < 16384 or alignment & (alignment - 1) or (segment["offset"] - segment["virtualAddress"]) % 16384:
                            compatible = False
                    elif (segment["virtualAddress"] + segment["memorySize"]) % 16384:
                        compatible = False
                if not compatible:
                    failures.append(entry.filename + ": ELF LOAD or GNU_RELRO does not satisfy 16 KB alignment")
            rows.append({"file": entry.filename, "abi": parts[1], "bits": bits, "bytes": len(data),
                         "sha256": hashlib.sha256(data).hexdigest(), "zipCompressed": entry.compress_type != 0,
                         "segments": segments, "elf16kCompatible": compatible if bits == 64 else None})
    packaged = {row["abi"] for row in rows}
    if packaged != ABIS:
        failures.append("Expected all four Android ABIs; found " + ",".join(sorted(packaged)))
    for abi in ABIS:
        present = {Path(row["file"]).name for row in rows if row["abi"] == abi}
        if not REQUIRED_LIBRARIES <= present:
            failures.append(abi + ": required ONNX Runtime JNI/core libraries missing")
    return {"apk": str(path), "apkSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "packagedAbis": sorted(packaged), "libraries": rows, "structuralFailures": failures,
            "runtimeClaim": False, "limits": "ELF/ABI inspection only; SDK zipalign and real runtime gates are separate."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-16k", action="store_true")
    args = parser.parse_args()
    report = inspect(args.apk)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(args.output), "abis": report["packagedAbis"], "failures": report["structuralFailures"]}))
    if args.require_16k and report["structuralFailures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
