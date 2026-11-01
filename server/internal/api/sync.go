package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type tableInfo struct {
	keyCol string
	table  string
}

func tableFor(t string) (tableInfo, bool) {
	switch t {
	case "tasks":
		return tableInfo{"id", "tasks"}, true
	case "daily_logs":
		return tableInfo{"date", "daily_logs"}, true
	case "prefs":
		return tableInfo{"key", "prefs"}, true
	}
	return tableInfo{}, false
}

// toInt64 把 JSON 解码出的任意数值类型统一转成 int64（毫秒时间戳）。
func toInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	}
	return 0
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	u := uid(r)
	var body struct {
		Changes []map[string]any `json:"changes"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	applied := make([]map[string]any, 0)
	conflicts := make([]map[string]any, 0)

	ctx := r.Context()
	for _, ch := range body.Changes {
		t, _ := ch["type"].(string)
		info, ok := tableFor(t)
		if !ok {
			continue
		}
		keyVal, _ := ch[info.keyCol].(string)
		if keyVal == "" {
			continue
		}
		updatedAt := toInt64(ch["updatedAt"])
		var deletedAt *int64
		if d := toInt64(ch["deletedAt"]); d != 0 {
			deletedAt = &d
		}
		// data = 去掉 type/updatedAt/deletedAt 后的整行
		data := make(map[string]any, len(ch))
		for k, v := range ch {
			if k == "type" || k == "updatedAt" || k == "deletedAt" {
				continue
			}
			data[k] = v
		}
		dataJSON, err := json.Marshal(data)
		if err != nil {
			continue
		}
		applied, conflicts = s.upsert(ctx, info, u, keyVal, updatedAt, deletedAt, dataJSON, applied, conflicts)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"applied":   applied,
		"conflicts": conflicts,
	})
}

func (s *Server) upsert(ctx context.Context, info tableInfo, u, keyVal string, updatedAt int64, deletedAt *int64, dataJSON []byte, applied, conflicts []map[string]any) ([]map[string]any, []map[string]any) {
	q := `select updated_at from ` + info.table + ` where user_id=$1 and ` + info.keyCol + `=$2`
	var existing int64
	err := s.Pool.QueryRow(ctx, q, u, keyVal).Scan(&existing)
	if err == pgx.ErrNoRows {
		_, e := s.Pool.Exec(ctx,
			`insert into `+info.table+`(user_id,`+info.keyCol+`,updated_at,deleted_at,data) values($1,$2,$3,$4,$5::jsonb)`,
			u, keyVal, updatedAt, deletedAt, string(dataJSON))
		if e == nil {
			applied = append(applied, map[string]any{info.keyCol: keyVal, "updatedAt": updatedAt})
		}
		return applied, conflicts
	}
	if err != nil {
		return applied, conflicts
	}
	if updatedAt > existing {
		_, e := s.Pool.Exec(ctx,
			`update `+info.table+` set updated_at=$1, deleted_at=$2, data=$3::jsonb where user_id=$4 and `+info.keyCol+`=$5`,
			updatedAt, deletedAt, string(dataJSON), u, keyVal)
		if e == nil {
			applied = append(applied, map[string]any{info.keyCol: keyVal, "updatedAt": updatedAt})
		}
		return applied, conflicts
	}
	conflicts = append(conflicts, map[string]any{info.keyCol: keyVal, "updatedAt": updatedAt})
	return applied, conflicts
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	u := uid(r)
	since := toInt64(r.URL.Query().Get("since"))
	types := strings.Split(r.URL.Query().Get("types"), ",")
	changes := make([]map[string]any, 0)

	ctx := r.Context()
	for _, t := range types {
		info, ok := tableFor(t)
		if !ok || t == "" {
			continue
		}
		q := `select ` + info.keyCol + `, updated_at, deleted_at, data from ` + info.table +
			` where user_id=$1 and (updated_at > $2 or deleted_at > $2)`
		rows, err := s.Pool.Query(ctx, q, u, since)
		if err != nil {
			continue
		}
		for rows.Next() {
			var k string
			var ua int64
			var da *int64
			var raw []byte
			if err := rows.Scan(&k, &ua, &da, &raw); err != nil {
				continue
			}
			var obj map[string]any
			if err := json.Unmarshal(raw, &obj); err != nil {
				continue
			}
			obj["type"] = t
			obj["updatedAt"] = ua
			if da != nil {
				obj["deletedAt"] = *da
			} else {
				obj["deletedAt"] = nil
			}
			changes = append(changes, obj)
		}
		rows.Close()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"server_time": time.Now().UnixMilli(),
		"changes":     changes,
	})
}
