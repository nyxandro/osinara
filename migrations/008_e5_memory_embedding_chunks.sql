-- E5 uses a different vector space and bounded inputs; old BGE vectors are intentionally not retained.
LOCK TABLE memory_items, memory_embedding_jobs IN ACCESS EXCLUSIVE MODE;

DROP INDEX memory_embedding_idx;

ALTER TABLE memory_items
  DROP COLUMN embedding,
  DROP COLUMN embedding_model;

-- One parent job produces a complete source-aligned chunk set in one transaction.
CREATE TABLE memory_embedding_chunks (
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (char_length(content) > 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  embedding vector(384) NOT NULL,
  embedding_model text NOT NULL CHECK (char_length(embedding_model) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, chunk_index)
);

CREATE INDEX memory_embedding_chunks_vector_idx
  ON memory_embedding_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memory_embedding_chunks_model_item_idx
  ON memory_embedding_chunks (embedding_model, memory_item_id);

-- Every existing record is reindexed from its authoritative text with fresh E5 leases.
TRUNCATE memory_embedding_jobs;
UPDATE memory_items SET embedding_status = 'pending';
INSERT INTO memory_embedding_jobs (memory_item_id)
SELECT id FROM memory_items;
