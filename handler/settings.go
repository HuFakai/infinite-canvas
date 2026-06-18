package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type adminChannelActionRequest struct {
	Index   *int               `json:"index"`
	Channel model.ModelChannel `json:"channel"`
	Model   string             `json:"model"`
}

func Settings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.PublicSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.Settings
	if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.SaveSettings(settings)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminChannelModels(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	models, err := service.AdminChannelModels(request.Index, request.Channel)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, models)
}

func AdminTestChannelModel(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	result, err := service.AdminTestChannelModel(request.Index, request.Channel, request.Model)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
