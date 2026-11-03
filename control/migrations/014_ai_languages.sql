-- Santralio: yapay zekâ karşılamasında çok dillilik.
-- languages: arayanın konuşabileceği diller (Azure dil tanıma adayları); greetings: dile göre karşılama (boşsa hazır metin).
ALTER TABLE ai_flows ADD COLUMN languages text[] NOT NULL DEFAULT '{tr-TR}';
ALTER TABLE ai_flows ADD COLUMN greetings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ai_flows ADD CONSTRAINT ai_flows_languages_check CHECK (cardinality(languages) BETWEEN 1 AND 10);
ALTER TABLE ai_sessions ADD COLUMN language text;
