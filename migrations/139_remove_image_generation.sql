-- Генерация картинок шла только через шлюз подписки CLIProxyAPI, а он убран из проекта 26.10.2026.
-- Журнал генераций больше никто не пишет и не читает: на проде в нём не было ни одной записи.
DROP TABLE image_generation_operations;

-- Право generate_image исчезло из каталога. Неизвестное имя в списке делает нечитаемой всю политику
-- группы и отключает ей все возможности, поэтому оно убирается из списков, а остальные права остаются.
UPDATE telegram_groups
   SET tool_allowlist = array_remove(tool_allowlist, 'generate_image')
 WHERE 'generate_image' = ANY(tool_allowlist);
