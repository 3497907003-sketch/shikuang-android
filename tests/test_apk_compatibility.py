"""Structural regression fixtures are ELF metadata, not runnable native code."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("inspect_apk", Path(__file__).resolve().parents[1] / "tools/inspect_apk.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def elf(bits=64, alignment=16384, relro_end=16384):
    data = bytearray(256)
    data[:6] = b"\x7fELF" + bytes((2 if bits == 64 else 1, 1))
    if bits == 64:
        struct.pack_into("<Q", data, 32, 64)
        struct.pack_into("<HH", data, 54, 56, 2)
        struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0, 0, 256, 16384, alignment)
        struct.pack_into("<IIQQQQQQ", data, 120, 0x6474E552, 4, 0, 0, 0, 0, relro_end, 1)
    else:
        struct.pack_into("<I", data, 28, 64)
        struct.pack_into("<HH", data, 42, 32, 2)
        struct.pack_into("<IIIIIIII", data, 64, 1, 0, 0, 0, 256, 16384, 5, alignment)
        struct.pack_into("<IIIIIIII", data, 96, 0x6474E552, 0, 0, 0, 0, relro_end, 4, 1)
    return bytes(data)


class ApkCompatibilityTest(unittest.TestCase):
    def report(self, changed=None):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "metadata-only.apk"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for abi in audit.ABIS:
                    for library in audit.REQUIRED_LIBRARIES:
                        name = f"lib/{abi}/{library}"
                        value = elf(64 if abi in {"arm64-v8a", "x86_64"} else 32)
                        archive.writestr(name, changed.get(name, value) if changed else value)
            return audit.inspect(path)

    def test_all_abis_and_16k_load_and_relro_are_independent_gates(self):
        self.assertEqual([], self.report()["structuralFailures"])
        self.assertFalse(self.report()["runtimeClaim"])
        for value in (elf(alignment=4096), elf(relro_end=4096)):
            report = self.report({"lib/arm64-v8a/libonnxruntime4j_jni.so": value})
            self.assertEqual(1, len(report["structuralFailures"]))
            self.assertIn("arm64-v8a", report["structuralFailures"][0])

    def test_malformed_program_headers_and_abi_word_size_fail_closed(self):
        for data in (b"invalid", elf()[:80]):
            with self.assertRaises(ValueError):
                audit.elf_segments(data)
        with self.assertRaises(ValueError):
            self.report({"lib/arm64-v8a/libonnxruntime4j_jni.so": elf(32)})


if __name__ == "__main__":
    unittest.main()
