-- Встроенные скиллы t-invest и pohuy убраны из релиза по решению владельца (18.10.2026).
-- Выдача несуществующего скилла при выдаче хода просто пропускается, но правка списка группы
-- проверяет каждое имя и упала бы на старом. Поэтому оба имени убираются из каждого сохранённого
-- списка скиллов группы; остальные скиллы остаются как были.
UPDATE telegram_groups
   SET skill_allowlist = array_remove(array_remove(skill_allowlist, 't-invest'), 'pohuy')
 WHERE skill_allowlist && ARRAY['t-invest', 'pohuy']::text[];
