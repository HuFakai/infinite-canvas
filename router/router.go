package router

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/middleware"
	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", gin.WrapF(handler.Register))
	api.POST("/auth/login", gin.WrapF(handler.Login))
	api.GET("/auth/linux-do/authorize", gin.WrapF(handler.LinuxDoAuthorize))
	api.GET("/auth/linux-do/callback", gin.WrapF(handler.LinuxDoCallback))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", gin.WrapF(handler.Settings))
	api.GET("/storage/config", gin.WrapF(handler.StorageConfig))
	api.GET("/files/:id", func(c *gin.Context) {
		handler.FileInfo(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/files/:id/content", func(c *gin.Context) {
		handler.FileContent(c.Writer, c.Request, c.Param("id"))
	})
	v1 := api.Group("/v1", middleware.UserAuth)
	v1.POST("/images/generations", gin.WrapF(handler.AIImagesGenerations))
	v1.POST("/images/edits", gin.WrapF(handler.AIImagesEdits))
	v1.POST("/chat/completions", gin.WrapF(handler.AIChatCompletions))
	v1.POST("/responses", gin.WrapF(handler.AIResponses))
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.POST("/files", gin.WrapF(handler.UploadFile))
	v1.DELETE("/files/:id", func(c *gin.Context) {
		handler.DeleteFile(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-config", gin.WrapF(handler.UserConfig))
	v1.POST("/user-config/model", gin.WrapF(handler.SaveUserModelConfig))
	v1.POST("/user-config/storage", gin.WrapF(handler.SaveUserStorageProvider))
	v1.GET("/user-data/canvas", gin.WrapF(handler.UserCanvasData))
	v1.POST("/user-data/canvas", gin.WrapF(handler.SaveUserCanvasData))
	v1.GET("/user-data/image-history", gin.WrapF(handler.UserImageHistory))
	v1.POST("/user-data/image-history", gin.WrapF(handler.SaveUserImageHistory))
	v1.GET("/user-data/assets", gin.WrapF(handler.UserAssetData))
	v1.POST("/user-data/assets", gin.WrapF(handler.SaveUserAssetData))
	v1.POST("/ai-logs", gin.WrapF(handler.ClientAICallLog))
	v1.GET("/workflows", gin.WrapF(handler.UserWorkflows))
	v1.POST("/workflows", gin.WrapF(handler.SaveUserWorkflow))
	v1.POST("/workflows/agent-draft", gin.WrapF(handler.DraftUserWorkflow))
	v1.DELETE("/workflows/:id", func(c *gin.Context) {
		handler.DeleteUserWorkflow(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/storage/measure", gin.WrapF(handler.MeasureUserStorageProvider))
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.POST("/admin/login", gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/ai-logs", gin.WrapF(handler.AdminAICallLogs))
	admin.DELETE("/ai-logs", gin.WrapF(handler.AdminDeleteAICallLogs))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/settings/channel-models", gin.WrapF(handler.AdminChannelModels))
	admin.POST("/settings/channel-test", gin.WrapF(handler.AdminTestChannelModel))
	admin.POST("/storage/measure", gin.WrapF(handler.AdminMeasureStorageProvider))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
