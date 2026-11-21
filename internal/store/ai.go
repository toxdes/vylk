package store

import (
	"database/sql"
	"errors"
	"time"

	"vylk/internal/ai"
)

func migrateAI(tx *sql.Tx) error {
	_, err := tx.Exec(`CREATE TABLE ai_configurations (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, api_url TEXT NOT NULL, api_key TEXT NOT NULL,
		is_default INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);
		CREATE UNIQUE INDEX ai_one_default ON ai_configurations(is_default) WHERE is_default=1;
		CREATE TABLE ai_models (configuration_id TEXT NOT NULL REFERENCES ai_configurations(id) ON DELETE CASCADE,
			model_id TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(configuration_id,model_id));
		CREATE TABLE ai_usage (
			id TEXT PRIMARY KEY, configuration_id TEXT NOT NULL, provider_name TEXT NOT NULL, model_id TEXT NOT NULL,
			note_id TEXT, session_id TEXT, turn_id TEXT, kind TEXT NOT NULL,
			started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL DEFAULT 'started', latency_ms INTEGER,
			input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER);
		CREATE INDEX ai_usage_note ON ai_usage(note_id,started_at);`)
	return err
}

func migrateAIOutputProfile(tx *sql.Tx) error {
	_, err := tx.Exec(`ALTER TABLE ai_configurations ADD COLUMN output_profile TEXT NOT NULL DEFAULT ''`)
	return err
}

func migrateAIPlanningLimits(tx *sql.Tx) error {
	_, err := tx.Exec(`ALTER TABLE ai_configurations ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
		ALTER TABLE ai_configurations ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 0;`)
	return err
}

func AIConfigurations(db *sql.DB) ([]ai.Configuration, error) {
	rows, err := db.Query(`SELECT c.id,c.name,c.api_url,c.api_key,m.model_id,m.checked,c.is_default,c.revision,c.output_profile,c.context_tokens,c.concurrency
		FROM ai_configurations c JOIN ai_models m ON m.configuration_id=c.id ORDER BY c.rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ai.Configuration{}
	for rows.Next() {
		var c ai.Configuration
		if err := rows.Scan(&c.ID, &c.Name, &c.URL, &c.Key, &c.Model, &c.Checked, &c.Default, &c.Revision, &c.OutputProfile, &c.ContextTokens, &c.Concurrency); err != nil {
			return nil, err
		}
		c.HasKey = c.Key != ""
		result = append(result, c)
	}
	return result, rows.Err()
}
func AIConfiguration(db *sql.DB, id string) (ai.Configuration, error) {
	all, err := AIConfigurations(db)
	if err != nil {
		return ai.Configuration{}, err
	}
	for _, c := range all {
		if c.ID == id {
			return c, nil
		}
	}
	return ai.Configuration{}, sql.ErrNoRows
}
func SaveAIConfiguration(db *sql.DB, c ai.Configuration, create bool, testedUsage ...string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if create {
		var count int
		if err = tx.QueryRow(`SELECT COUNT(*) FROM ai_configurations`).Scan(&count); err != nil {
			return err
		}
		if count >= 32 {
			return errors.New("at most 32 AI configurations are supported")
		}
		_, err = tx.Exec(`INSERT INTO ai_configurations(id,name,api_url,api_key,output_profile,context_tokens,concurrency) VALUES(?,?,?,?,?,?,?)`, c.ID, c.Name, c.URL, c.Key, c.OutputProfile, c.ContextTokens, c.Concurrency)
	} else {
		var result sql.Result
		result, err = tx.Exec(`UPDATE ai_configurations SET name=?,api_url=?,api_key=?,output_profile=?,context_tokens=?,concurrency=?,revision=revision+1 WHERE id=? AND revision=?`, c.Name, c.URL, c.Key, c.OutputProfile, c.ContextTokens, c.Concurrency, c.ID, c.Revision)
		if err == nil {
			n, e := result.RowsAffected()
			if e != nil {
				return e
			}
			if n != 1 {
				return ErrRevisionConflict
			}
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM ai_models WHERE configuration_id=?`, c.ID); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO ai_models(configuration_id,model_id,checked) VALUES(?,?,?)`, c.ID, c.Model, c.Checked); err != nil {
		return err
	}
	if len(testedUsage) > 0 {
		result, err := tx.Exec(`UPDATE ai_usage SET configuration_id=?,provider_name=?,kind='check' WHERE id=? AND kind='test' AND outcome='success'`, c.ID, c.Name, testedUsage[0])
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return errors.New("configuration test already used; test it again")
		}
		var previous bool
		if err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM ai_usage WHERE kind='check' AND outcome='success' AND id<>?)`, testedUsage[0]).Scan(&previous); err != nil {
			return err
		}
		if !previous {
			if _, err = tx.Exec(`UPDATE ai_configurations SET is_default=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM ai_configurations WHERE is_default=1)`, c.ID); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}
func CheckAIConfiguration(db *sql.DB, c ai.Configuration) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var revision int64
	if err = tx.QueryRow(`SELECT revision FROM ai_configurations WHERE id=?`, c.ID).Scan(&revision); err != nil {
		return err
	}
	if revision != c.Revision {
		return ErrRevisionConflict
	}
	if _, err = tx.Exec(`UPDATE ai_models SET checked=1 WHERE configuration_id=? AND model_id=?`, c.ID, c.Model); err != nil {
		return err
	}
	// Only the first ever successful check selects a provider automatically.
	var previous int
	if err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM ai_usage WHERE kind='check' AND outcome='success')`).Scan(&previous); err != nil {
		return err
	}
	if previous == 0 {
		if _, err = tx.Exec(`UPDATE ai_configurations SET is_default=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM ai_configurations WHERE is_default=1)`, c.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func UncheckAIConfiguration(db *sql.DB, c ai.Configuration) error {
	_, err := db.Exec(`UPDATE ai_models SET checked=0 WHERE configuration_id=? AND model_id=? AND EXISTS(SELECT 1 FROM ai_configurations WHERE id=? AND revision=?)`, c.ID, c.Model, c.ID, c.Revision)
	return err
}
func DefaultAIConfiguration(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var checked bool
	if err = tx.QueryRow(`SELECT checked FROM ai_models WHERE configuration_id=?`, id).Scan(&checked); err != nil {
		return err
	}
	if !checked {
		return errors.New("check this configuration first")
	}
	if _, err = tx.Exec(`UPDATE ai_configurations SET is_default=0 WHERE is_default=1`); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE ai_configurations SET is_default=1 WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}
func DeleteAIConfiguration(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM ai_models WHERE configuration_id=?`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM ai_configurations WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}
func StartAIUsage(db *sql.DB, id string, c ai.Configuration, noteID, sessionID, turnID, kind string) error {
	_, err := db.Exec(`INSERT INTO ai_usage(id,configuration_id,provider_name,model_id,note_id,session_id,turn_id,kind,started_at) VALUES(?,?,?,?,NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?)`, id, c.ID, c.Name, c.Model, noteID, sessionID, turnID, kind, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}
func FinishAIUsage(db *sql.DB, id, outcome string, latency time.Duration, u ai.Usage) error {
	_, err := db.Exec(`UPDATE ai_usage SET finished_at=?,outcome=?,latency_ms=?,input_tokens=?,output_tokens=?,total_tokens=?,cached_tokens=?,reasoning_tokens=? WHERE id=?`, time.Now().UTC().Format(time.RFC3339Nano), outcome, latency.Milliseconds(), u.Input, u.Output, u.Total, u.InputDetails.Cached, u.OutputDetails.Reasoning, id)
	return err
}
