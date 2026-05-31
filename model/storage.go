package model

type StorageObject struct {
	ID         string `json:"id" gorm:"primaryKey"`
	ProviderID string `json:"providerId" gorm:"index"`
	Bucket     string `json:"bucket"`
	ObjectKey  string `json:"objectKey" gorm:"uniqueIndex"`
	PublicURL  string `json:"publicUrl"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SHA256     string `json:"sha256"`
	CreatedBy  string `json:"createdBy" gorm:"index"`
	CreatedAt  string `json:"createdAt"`
	DeletedAt  string `json:"deletedAt"`
}

type UserConfig struct {
	UserID          string `json:"userId" gorm:"primaryKey"`
	ModelConfig     string `json:"modelConfig" gorm:"type:text"`
	StorageProvider string `json:"storageProvider" gorm:"type:text"`
	CanvasData      string `json:"canvasData" gorm:"type:text"`
	ImageHistory    string `json:"imageHistory" gorm:"type:text"`
	AssetData       string `json:"assetData" gorm:"type:text"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}

type CreativeWorkflow struct {
	ID          string `json:"id" gorm:"primaryKey"`
	OwnerUserID string `json:"ownerUserId" gorm:"index"`
	Scope       string `json:"scope" gorm:"index"`
	Name        string `json:"name" gorm:"index"`
	Category    string `json:"category" gorm:"index"`
	Description string `json:"description"`
	Data        string `json:"data" gorm:"type:text"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
	LastRunAt   string `json:"lastRunAt"`
}
