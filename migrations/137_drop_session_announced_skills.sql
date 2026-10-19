-- agent_session_state.announced_skills хранил список скиллов, последний раз показанный модели в
-- сессии. С v0.47.0 его никто не читает: список скиллов каждого хода и так лежит в
-- agent_turns.prepared. Ядро больше не пишет колонку, она уходит.
ALTER TABLE agent_session_state DROP COLUMN announced_skills;
