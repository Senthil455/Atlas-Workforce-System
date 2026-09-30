import logging
import os
import uuid
from typing import Tuple, Optional

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {'.pdf', '.doc', '.docx', '.txt', '.rtf'}
ALLOWED_MIME_TYPES = {
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'application/rtf',
    'text/rtf',
}
MAX_FILE_SIZE = 10 * 1024 * 1024
EXECUTABLE_MAGIC_PREFIXES = [
    b'MZ', b'\x7fELF', b'#!', b'\xca\xfe\xba\xbe', b'\xcf\xfa\xed\xfe',
]
UPLOAD_DIR = os.environ.get('FILE_UPLOAD_DIR', '/data/uploads')


def validate_file_extension(filename: str) -> bool:
    _, ext = os.path.splitext(filename)
    return ext.lower() in ALLOWED_EXTENSIONS


def validate_mime_type(file_bytes: bytes) -> bool:
    mime_map = {
        b'%PDF': 'application/pdf',
        b'\xd0\xcf\x11\xe0': 'application/msword',
        b'PK\x03\x04': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
    for magic_bytes, mime in mime_map.items():
        if file_bytes.startswith(magic_bytes):
            return mime in ALLOWED_MIME_TYPES
    try:
        text = file_bytes.decode('utf-8', errors='ignore')
        if text.isprintable() or '\n' in text or '\r' in text:
            return 'text/plain' in ALLOWED_MIME_TYPES
    except (UnicodeError, ValueError) as e:
        logger.warning("file.mime_text_check_failed", extra={"error": str(e)})
        return False
    return False


def validate_file_size(file_bytes: bytes) -> bool:
    return len(file_bytes) <= MAX_FILE_SIZE


def scan_for_executable_content(file_bytes: bytes) -> bool:
    for prefix in EXECUTABLE_MAGIC_PREFIXES:
        if file_bytes.startswith(prefix):
            return False
    return True


def validate_file(filename: str, file_bytes: bytes) -> Tuple[bool, Optional[str]]:
    if not validate_file_extension(filename):
        return False, f"File extension not allowed. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
    if not validate_mime_type(file_bytes):
        return False, "File MIME type not allowed"
    if not validate_file_size(file_bytes):
        return False, f"File exceeds maximum size of {MAX_FILE_SIZE // (1024*1024)}MB"
    if not scan_for_executable_content(file_bytes):
        return False, "File contains executable content patterns"
    return True, None


def get_secure_path(original_filename: str) -> str:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    _, ext = os.path.splitext(original_filename)
    secure_name = f"{uuid.uuid4().hex}{ext.lower()}"
    return os.path.join(UPLOAD_DIR, secure_name)
