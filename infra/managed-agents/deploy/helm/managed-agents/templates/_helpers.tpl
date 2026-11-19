{{/*
Expand the name of the chart.
*/}}
{{- define "managed-agents.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "managed-agents.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "managed-agents.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "managed-agents.labels" -}}
helm.sh/chart: {{ include "managed-agents.chart" . }}
{{ include "managed-agents.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
environment: {{ .Values.global.environment }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "managed-agents.selectorLabels" -}}
app.kubernetes.io/name: {{ include "managed-agents.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "managed-agents.serviceAccountName" -}}
{{- if .Values.rbac.serviceAccount.create }}
{{- default (include "managed-agents.fullname" .) .Values.rbac.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.rbac.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
PostgreSQL hostname
*/}}
{{- define "managed-agents.postgres.host" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgresql" (include "managed-agents.fullname" .) }}
{{- else }}
{{- .Values.externalPostgres.host }}
{{- end }}
{{- end }}

{{/*
PostgreSQL database URL
*/}}
{{- define "managed-agents.postgres.url" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgresql+asyncpg://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password (include "managed-agents.fullname" .) .Values.postgresql.auth.database }}
{{- else }}
{{- .Values.externalPostgres.url }}
{{- end }}
{{- end }}

{{/*
Redis hostname
*/}}
{{- define "managed-agents.redis.host" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis" (include "managed-agents.fullname" .) }}
{{- else }}
{{- .Values.externalRedis.host }}
{{- end }}
{{- end }}

{{/*
Redis connection URL
*/}}
{{- define "managed-agents.redis.url" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s-redis:6379" (include "managed-agents.fullname" .) }}
{{- else }}
{{- .Values.externalRedis.url }}
{{- end }}
{{- end }}

{{/*
Session namespace name
*/}}
{{- define "managed-agents.session.namespace" -}}
{{- default "managed-agents-sessions" .Values.sessions.namespace }}
{{- end }}
