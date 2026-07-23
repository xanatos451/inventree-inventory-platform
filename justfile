# Workspace automation for extension and InvenTree plugin development.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

ext_dir := "extensions/chrome-multi-site-inventree-export"
svg_ext_dir := "extensions/chrome-svg-capture-extension"
plugin_dir := "plugins/inventree-multi-site-importer"

# Show all available recipes.
@default:
	just --list

# Install extension dependencies and Playwright Chromium.
extension-install:
	Set-Location "{{ext_dir}}"; npm ci
	Set-Location "{{ext_dir}}"; npx playwright install chromium

# Run extension JavaScript syntax checks.
extension-syntax:
	Set-Location "{{ext_dir}}"; npm run test:syntax
	node --check "{{svg_ext_dir}}/background.js"
	node --check "{{svg_ext_dir}}/popup.js"

# Run extension integration tests.
extension-test:
	Set-Location "{{ext_dir}}"; npm run test:integration

# Run all extension validation.
extension-validate:
	Set-Location "{{ext_dir}}"; npm run validate

# Run plugin contract, mapping, and field-inspection tests.
plugin-test:
	Set-Location "{{plugin_dir}}"; python -m unittest discover -s tests -v

# Compile plugin Python sources.
plugin-compile:
	Set-Location "{{plugin_dir}}"; python -m compileall -q inventree_multi_site_importer

# Build and verify the plugin wheel in .artifacts/plugin/.
plugin-build:
	Set-Location "{{plugin_dir}}"; python scripts/build_plugin.py --clean

# Print the wheel produced by plugin-build.
plugin-artifact: plugin-build
	Get-ChildItem ".artifacts/plugin" -Filter "*.whl" | Select-Object FullName,Length,LastWriteTime

# Run plugin tests, compilation, and package build.
plugin: plugin-test plugin-compile plugin-build

# Run all locally reproducible CI checks and build the plugin artifact.
check: security-scan extension-syntax extension-test plugin

# Scan source for private keys, credential files, and common provider-token formats.
security-scan:
	python scripts/check_secrets.py

# Install dependencies, then run the complete workspace check.
ci: extension-install check

# Backwards-compatible aliases from the original justfile.
ci-install: extension-install
ci-test: extension-test
validate: check
