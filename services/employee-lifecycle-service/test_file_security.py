from file_security import validate_file, validate_mime_type


def test_pdf_magic_accepted():
    assert validate_mime_type(b"%PDF-1.4 hello") is True


def test_binary_blob_rejected():
    assert validate_mime_type(b"\x00\x01\x02\x03\xff\xfe") is False


def test_undecodable_bytes_rejected_not_skipped():
    ok, reason = validate_file("notes.txt", b"\x00\x01\x02\x03\xff\xfe")
    assert ok is False
    assert reason == "File MIME type not allowed"


def test_executable_prefix_rejected():
    ok, reason = validate_file("report.pdf", b"MZ" + b"\x00" * 100)
    assert ok is False
