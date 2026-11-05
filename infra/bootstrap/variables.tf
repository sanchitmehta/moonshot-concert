variable "subscription_id" {
  description = "Azure subscription that hosts Moonshot Fest."
  type        = string
}

variable "location" {
  description = "Azure region for every resource group."
  type        = string
  default     = "eastus2"
}

variable "github_repository" {
  description = "GitHub repository (owner/name) whose main branch may deploy."
  type        = string
  default     = "sanchitmehta/moonshot-concert"
}

variable "state_storage_account_name" {
  description = "Globally unique storage account name for Terraform state."
  type        = string
  default     = "stmoonshottfstate"
}
