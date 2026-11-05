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
  description = "GitHub repository as it appears in the Actions OIDC subject claim (owner@ownerId/name@repoId)."
  type        = string
  default     = "sanchitmehta@10647778/moonshot-concert@1446262360"
}

variable "state_storage_account_name" {
  description = "Globally unique storage account name for Terraform state."
  type        = string
  default     = "stmoonshottfstate"
}
