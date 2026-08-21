import re
import json

from rest_framework import serializers

from .models import CaptureImport, MappingProfile


class MappingProfileSerializer(serializers.ModelSerializer):
    def validate_rules(self, rules):
        if not isinstance(rules, dict):
            raise serializers.ValidationError("Rules must be an object.")
        if len(rules) > 250:
            raise serializers.ValidationError("A profile cannot contain more than 250 mapping rules.")
        cleaned = {}
        for target, rule in rules.items():
            target = str(target).strip()
            if not target or len(target) > 200 or not isinstance(rule, dict):
                raise serializers.ValidationError("Each rule requires a valid target name and rule object.")
            source_field = str(rule.get("source_field") or rule.get("sourceField") or "").strip()
            template = str(rule.get("template") or "")
            regex = str(rule.get("regex") or "").strip()
            if not source_field and not template:
                raise serializers.ValidationError(f"Rule '{target}' requires a source field or template.")
            if len(source_field) > 500 or len(template) > 4000 or len(regex) > 1000:
                raise serializers.ValidationError(f"Rule '{target}' exceeds the supported length.")
            placeholder_count = len(re.findall(r"\{[^{}]+\}", template))
            if placeholder_count > 50:
                raise serializers.ValidationError(f"Rule '{target}' contains too many template placeholders.")
            cleaned[target] = {
                **({"source_field": source_field} if source_field and not template else {}),
                **({"template": template} if template else {}),
                "regex": regex,
            }
        return cleaned

    class Meta:
        model = MappingProfile
        fields = [
            "pk", "name", "source", "capture_profile", "page_type", "host_pattern", "path_pattern",
            "rules", "is_active", "priority", "created_at", "updated_at",
        ]
        read_only_fields = ["pk", "created_at", "updated_at"]


class CaptureImportSerializer(serializers.ModelSerializer):
    class Meta:
        model = CaptureImport
        fields = [
            "pk", "contract_version", "capture_profile", "source", "page_type", "page_title",
            "page_url", "captured_at", "payload", "row_count", "status",
            "profile", "error", "inventory_written_at", "imported_stages",
            "pinned", "created_at", "updated_at",
        ]
        read_only_fields = [
            "pk", "row_count", "status", "error", "inventory_written_at",
            "imported_stages", "pinned", "created_at", "updated_at",
        ]

    def validate_payload(self, payload):
        if not isinstance(payload, dict):
            raise serializers.ValidationError("Payload must be an object.")
        max_payload_bytes = int(self.context.get("max_capture_payload_bytes", 8388608))
        try:
            payload_size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError) as exc:
            raise serializers.ValidationError("Payload contains unsupported JSON values.") from exc
        if payload_size > max_payload_bytes:
            raise serializers.ValidationError(
                f"Payload exceeds the {max_payload_bytes} byte limit."
            )

        rows = payload.get("rows")
        if not isinstance(rows, list) or not rows:
            raise serializers.ValidationError("Payload must contain a non-empty rows array.")
        if not all(isinstance(row, dict) for row in rows):
            raise serializers.ValidationError("Every captured row must be an object.")

        limit = int(self.context.get("max_capture_rows", 5000))
        if len(rows) > limit:
            raise serializers.ValidationError(f"Capture exceeds the {limit} row limit.")

        max_row_fields = int(self.context.get("max_capture_row_fields", 500))
        max_field_name_length = int(self.context.get("max_capture_field_name_length", 255))
        max_cell_length = int(self.context.get("max_capture_cell_length", 32000))
        for row_index, row in enumerate(rows, start=1):
            if len(row) > max_row_fields:
                raise serializers.ValidationError(
                    f"Row {row_index} exceeds the {max_row_fields} field limit."
                )
            for field_name, value in row.items():
                key = str(field_name or "").strip()
                if not key:
                    raise serializers.ValidationError(
                        f"Row {row_index} contains an empty field name."
                    )
                if len(key) > max_field_name_length:
                    raise serializers.ValidationError(
                        f"Row {row_index} field '{key[:40]}' exceeds the {max_field_name_length} character name limit."
                    )

                if isinstance(value, (dict, list)):
                    rendered = json.dumps(value, ensure_ascii=False)
                elif value is None:
                    rendered = ""
                else:
                    rendered = str(value)
                if len(rendered) > max_cell_length:
                    raise serializers.ValidationError(
                        f"Row {row_index} field '{key}' exceeds the {max_cell_length} character value limit."
                    )
        return payload

    def create(self, validated_data):
        payload = validated_data["payload"]
        validated_data["row_count"] = len(payload["rows"])
        request = self.context.get("request")
        if request and request.user and request.user.is_authenticated:
            validated_data["submitted_by"] = request.user
        return super().create(validated_data)
