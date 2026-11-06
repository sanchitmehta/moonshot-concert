variable "subscription_id" {
  description = "Azure subscription that hosts Moonshot Fest."
  type        = string
}

variable "location" {
  description = "Azure region for resource groups and identities (metadata only)."
  type        = string
  default     = "eastus2"
}

variable "workload_location" {
  description = "Azure region for the team workloads. southcentralus has App Service quota in this subscription; eastus2 has none."
  type        = string
  default     = "southcentralus"
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

variable "aws_account_id" {
  description = "AWS account that hosts the Data Platform's AWS resources."
  type        = string
  default     = "773129457890"
}

variable "aws_region" {
  description = "AWS region for the Data Platform's AWS resources."
  type        = string
  default     = "us-east-2"
}