package service

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
)

const (
	aiLogTextLimit        = 64 * 1024
	defaultAILogCron      = "0 3 * * *"
	defaultAILogRetention = 14
)

var (
	aiLogCleanupCron *cron.Cron
	aiLogCleanupOnce sync.Once
	aiLogCleanupMu   sync.Mutex
)

type AICallLogInput struct {
	UserID          string `json:"userId"`
	UserDisplayName string `json:"userDisplayName"`
	Endpoint        string `json:"endpoint"`
	Method          string `json:"method"`
	Model           string `json:"model"`
	ChannelID       string `json:"channelId"`
	ChannelName     string `json:"channelName"`
	Status          int    `json:"status"`
	DurationMs      int64  `json:"durationMs"`
	Credits         int    `json:"credits"`
	RequestBody     string `json:"requestBody"`
	ResponseBody    string `json:"responseBody"`
	Error           string `json:"error"`
}

func SaveAICallLog(input AICallLogInput) {
	item := model.AICallLog{
		ID:              uuid.NewString(),
		UserID:          strings.TrimSpace(input.UserID),
		UserDisplayName: strings.TrimSpace(input.UserDisplayName),
		Endpoint:        strings.TrimSpace(input.Endpoint),
		Method:          strings.TrimSpace(input.Method),
		Model:           strings.TrimSpace(input.Model),
		ChannelID:       strings.TrimSpace(input.ChannelID),
		ChannelName:     strings.TrimSpace(input.ChannelName),
		Status:          input.Status,
		DurationMs:      input.DurationMs,
		Credits:         input.Credits,
		RequestBody:     truncateLogText(input.RequestBody, aiLogTextLimit),
		ResponseBody:    truncateLogText(input.ResponseBody, aiLogTextLimit),
		Error:           truncateLogText(input.Error, 4096),
		CreatedAt:       now(),
	}
	if err := appendAICallLog(item); err != nil {
		log.Printf("write ai call log failed err=%v", err)
	}
}

func ListAICallLogs(q model.Query) (model.AICallLogList, error) {
	q.Normalize()
	items, err := readAICallLogs()
	if err != nil {
		return model.AICallLogList{}, err
	}
	if keyword := strings.ToLower(strings.TrimSpace(q.Keyword)); keyword != "" {
		filtered := make([]model.AICallLog, 0, len(items))
		for _, item := range items {
			if aiLogMatchesKeyword(item, keyword) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].CreatedAt > items[j].CreatedAt
	})
	total := len(items)
	start := q.Offset()
	if start >= total {
		return model.AICallLogList{Items: []model.AICallLog{}, Total: total}, nil
	}
	end := start + q.PageSize
	if end > total {
		end = total
	}
	return model.AICallLogList{Items: items[start:end], Total: total}, nil
}

func DeleteAICallLogsOlderThan(days int) (int, error) {
	if days <= 0 {
		days = 7
	}
	cutoff := time.Now().AddDate(0, 0, -days)
	files, err := aiLogFiles()
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, file := range files {
		fileDate, ok := aiLogFileDate(file)
		if !ok || !fileDate.Before(startOfDay(cutoff)) {
			continue
		}
		if err := os.Remove(file); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func StartAILogCleanupScheduler() {
	aiLogCleanupOnce.Do(func() {
		aiLogCleanupCron = cron.New()
		aiLogCleanupCron.Start()
	})
	RefreshAILogCleanupScheduler()
}

func RefreshAILogCleanupScheduler() {
	aiLogCleanupMu.Lock()
	defer aiLogCleanupMu.Unlock()
	if aiLogCleanupCron == nil {
		return
	}
	for _, entry := range aiLogCleanupCron.Entries() {
		aiLogCleanupCron.Remove(entry.ID)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load ai log cleanup setting failed err=%v", err)
		return
	}
	setting := normalizeAILogCleanupSetting(settings.Private.AILog.Cleanup)
	if setting.Enabled == nil || !*setting.Enabled {
		return
	}
	if _, err := aiLogCleanupCron.AddFunc(setting.Cron, func() {
		removed, err := DeleteAICallLogsOlderThan(setting.RetentionDays)
		if err != nil {
			log.Printf("scheduled ai log cleanup failed err=%v", err)
			return
		}
		log.Printf("scheduled ai log cleanup done removedFiles=%d retentionDays=%d", removed, setting.RetentionDays)
	}); err != nil {
		log.Printf("add ai log cleanup cron failed cron=%s err=%v", setting.Cron, err)
	}
}

func normalizeAILogCleanupSetting(setting model.AILogCleanupSetting) model.AILogCleanupSetting {
	if setting.Cron == "" {
		setting.Cron = defaultAILogCron
	}
	if setting.RetentionDays <= 0 {
		setting.RetentionDays = defaultAILogRetention
	}
	if setting.Enabled == nil {
		enabled := false
		setting.Enabled = &enabled
	}
	return setting
}

func appendAICallLog(item model.AICallLog) error {
	dir := strings.TrimSpace(config.Cfg.AILogDir)
	if dir == "" {
		dir = filepath.Join("data", "logs", "ai-calls")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	filePath := filepath.Join(dir, fmt.Sprintf("ai-calls-%s.log", time.Now().Format("2006-01-02")))
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	defer file.Close()
	encoded, err := json.Marshal(item)
	if err != nil {
		return err
	}
	log.New(file, "", 0).Println(string(encoded))
	return nil
}

func readAICallLogs() ([]model.AICallLog, error) {
	files, err := aiLogFiles()
	if err != nil {
		return nil, err
	}
	items := []model.AICallLog{}
	for _, file := range files {
		fileItems, err := readAICallLogFile(file)
		if err != nil {
			log.Printf("read ai call log file failed file=%s err=%v", file, err)
			continue
		}
		items = append(items, fileItems...)
	}
	return items, nil
}

func readAICallLogFile(filePath string) ([]model.AICallLog, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 512*1024)
	items := []model.AICallLog{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var item model.AICallLog
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			continue
		}
		items = append(items, item)
	}
	return items, scanner.Err()
}

func aiLogFiles() ([]string, error) {
	dir := strings.TrimSpace(config.Cfg.AILogDir)
	if dir == "" {
		dir = filepath.Join("data", "logs", "ai-calls")
	}
	files, err := filepath.Glob(filepath.Join(dir, "ai-calls-*.log"))
	if err != nil {
		return nil, err
	}
	sort.Sort(sort.Reverse(sort.StringSlice(files)))
	return files, nil
}

func aiLogFileDate(filePath string) (time.Time, bool) {
	name := filepath.Base(filePath)
	value := strings.TrimSuffix(strings.TrimPrefix(name, "ai-calls-"), ".log")
	parsed, err := time.ParseInLocation("2006-01-02", value, time.Local)
	return parsed, err == nil
}

func startOfDay(value time.Time) time.Time {
	year, month, day := value.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, value.Location())
}

func aiLogMatchesKeyword(item model.AICallLog, keyword string) bool {
	fields := []string{item.UserID, item.UserDisplayName, item.Endpoint, item.Method, item.Model, item.ChannelID, item.ChannelName, item.RequestBody, item.ResponseBody, item.Error, strconv.Itoa(item.Status)}
	for _, field := range fields {
		if strings.Contains(strings.ToLower(field), keyword) {
			return true
		}
	}
	return false
}

func truncateLogText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "\n... [truncated]"
}
