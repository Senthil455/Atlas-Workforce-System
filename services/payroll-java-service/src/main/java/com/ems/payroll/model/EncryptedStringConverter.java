package com.ems.payroll.model;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;

@Converter
public class EncryptedStringConverter implements AttributeConverter<String, String> {

    private static final String ALGORITHM = "AES/ECB/PKCS5Padding";
    private static final String ENV_KEY = "BANK_ENCRYPTION_KEY";
    private static final String FALLBACK_KEY = "CHANGE-ME-32-CHAR-KEY-FOR-PROD!!";

    private static SecretKeySpec keySpec;

    private SecretKeySpec getKey() {
        if (keySpec == null) {
            String raw = System.getenv(ENV_KEY);
            if (raw == null || raw.isEmpty()) {
                raw = FALLBACK_KEY;
            }
            byte[] keyBytes;
            if (raw.length() == 32) {
                keyBytes = raw.getBytes(StandardCharsets.UTF_8);
            } else {
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                keyBytes = Arrays.copyOf(sha.digest(raw.getBytes(StandardCharsets.UTF_8)), 32);
            }
            keySpec = new SecretKeySpec(keyBytes, "AES");
        }
        return keySpec;
    }

    @Override
    public String convertToDatabaseColumn(String attribute) {
        if (attribute == null) return null;
        try {
            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.ENCRYPT_MODE, getKey());
            byte[] encrypted = cipher.doFinal(attribute.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(encrypted);
        } catch (Exception e) {
            throw new RuntimeException("Encryption failed", e);
        }
    }

    @Override
    public String convertToEntityAttribute(String dbData) {
        if (dbData == null) return null;
        try {
            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.DECRYPT_MODE, getKey());
            byte[] decrypted = cipher.doFinal(Base64.getDecoder().decode(dbData));
            return new String(decrypted, StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException("Decryption failed", e);
        }
    }
}
