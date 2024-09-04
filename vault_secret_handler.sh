#!/bin/bash

# Vault address
export VAULT_ADDR='http://127.0.0.1:8200'

# AppRole credentials
ROLE_ID='95df3211-643f-b3a4-ebca-1dc7d16e6655'
SECRET_ID='321962aa-ecc9-5bdf-a5b6-056124e6abd0'

# Function to authenticate with Vault using AppRole
authenticate_vault() {
    echo "Authenticating with Vault..."
    DO_NOT_LOG_NEVER_COMMIT_VALUEOF_VAULT_TOKEN=$(vault write -field=token auth/approle/login \
        role_id="$ROLE_ID" \
        secret_id="$SECRET_ID")
    if [ -z "$DO_NOT_LOG_NEVER_COMMIT_VALUEOF_VAULT_TOKEN" ]; then
        echo "Failed to authenticate with Vault."
        exit 1
    fi
    export DO_NOT_LOG_NEVER_COMMIT_VALUEOF_VAULT_TOKEN
    echo "Authentication successful."
}

# Function to store the secrets
store_secrets() {
    local server_secret=$(cat "$1")
    local client_secret=$(cat "$2")
    echo "Storing secrets..."
    vault kv put secret/podman-keys account_server="$server_secret" account_client="$client_secret"
    if [ $? -eq 0 ]; then
        echo "Secrets stored successfully."
    else
        echo "Failed to store secrets."
        exit 1
    fi
}

# Function to retrieve and echo the secrets individually
retrieve_secrets() {
    echo "Retrieving secrets..."
    
    # Retrieve and echo the first secret
    RETRIEVED_SECRET_1=$(vault kv get -format=json secret/podman-keys | jq -r '.data.data.account_server')
    if [ $? -eq 0 ]; then
        echo "First secret (account_server) retrieved successfully:"
        echo "$RETRIEVED_SECRET_1" | jq .
    else
        echo "Failed to retrieve first secret."
        exit 1
    fi

    echo "------------------------"

    # Retrieve and echo the second secret
    RETRIEVED_SECRET_2=$(vault kv get -format=json secret/podman-keys | jq -r '.data.data.account_client')
    if [ $? -eq 0 ]; then
        echo "Second secret (account_client) retrieved successfully:"
        echo "$RETRIEVED_SECRET_2" | jq .
    else
        echo "Failed to retrieve second secret."
        exit 1
    fi
}

# Function to validate JSON file
validate_json_file() {
    if ! jq . "$1" >/dev/null 2>&1; then
        echo "Error: File '$1' does not contain valid JSON."
        exit 1
    fi
}

# Main execution
echo "Vault JSON Secret Handler"
echo "========================"

# Check if two JSON file paths are provided as arguments
if [ $# -ne 2 ]; then
    echo "Error: Please provide paths to two JSON files as arguments."
    echo "Usage: $0 <path_to_server_json_file> <path_to_client_json_file>"
    exit 1
fi

# Validate that the files exist and contain valid JSON
for file in "$1" "$2"; do
    if [ ! -f "$file" ]; then
        echo "Error: File '$file' does not exist."
        exit 1
    fi
    validate_json_file "$file"
done

# Ensure Vault is initialized and unsealed
vault status > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "Error: Vault is not initialized or unsealed. Please check your Vault setup."
    exit 1
fi

# Authenticate with Vault
authenticate_vault

# Store the secrets
store_secrets "$1" "$2"

# Retrieve and echo the secrets individually
retrieve_secrets

echo "========================"
echo "Script completed."