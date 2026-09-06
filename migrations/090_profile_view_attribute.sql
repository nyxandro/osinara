-- Снимок профиля должен воспроизводить слот записи, иначе read_profile_view вернёт не тот же вид,
-- который модель получила в контексте хода.
ALTER TABLE profile_view_claims
  ADD COLUMN attribute_snapshot text
    CHECK (attribute_snapshot IS NULL OR char_length(attribute_snapshot) BETWEEN 1 AND 64);
