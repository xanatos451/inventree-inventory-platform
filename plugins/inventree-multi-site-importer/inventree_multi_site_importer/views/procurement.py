"""Supplier/manufacturer record sync and stock-item creation; both run only after parts already exist."""

from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView
from django.db import transaction

from ..models import StockImportRecord
from .common import _capture_or_404, _mark_inventory_write, _resolved_part, _workflow_items, logger, _build_live_import_plan


class ImportCaptureProcurementView(APIView):
    """Write supplier/manufacturer records in a separate confirmed stage."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response({"detail": "Set confirm to true."}, status=400)
        mode = str(request.data.get("existing_part_mode") or "update").lower()
        if mode not in {"update", "overwrite"}:
            return Response({"detail": "Invalid update mode."}, status=400)
        from company.models import Company, ManufacturerPart, SupplierPart, SupplierPriceBreak
        from decimal import Decimal
        from djmoney.money import Money
        from part.models import Part
        from users.permissions import check_user_permission
        capture = _capture_or_404(request, pk)
        counts = {"manufacturer_created": 0, "manufacturer_updated": 0,
                  "supplier_created": 0, "supplier_updated": 0}
        try:
            plan = _build_live_import_plan(_workflow_items(request, capture))
            if not plan["ready"] or plan["summary"]["create"]:
                return Response({"detail": "Create all Parts and resolve plan errors first.", "rows": plan["rows"]}, status=409)
            needed_models = []
            if any(row["manufacturer_action"] != "none" for row in plan["rows"]):
                needed_models.append(ManufacturerPart)
            if any(row["supplier_action"] != "none" for row in plan["rows"]):
                needed_models.append(SupplierPart)
            if any(row["mapped"].get("supplier.price") for row in plan["rows"]):
                needed_models.append(SupplierPriceBreak)
            if any(
                not check_user_permission(request.user, model, permission)
                for model in needed_models
                for permission in ("add", "change")
            ):
                return Response(
                    {"detail": "Add and change permissions are required for the mapped procurement records."},
                    status=403,
                )
            with transaction.atomic():
                for row in plan["rows"]:
                    mapped = row["mapped"]
                    part = _resolved_part(row, Part)
                    manufacturer_part = None
                    company_name = str(mapped.get("manufacturer.company") or "").strip()
                    mpn = str(mapped.get("manufacturer.mpn") or "").strip()
                    if company_name and mpn:
                        company = Company.objects.get(name__iexact=company_name, is_manufacturer=True)
                        manufacturer_part, made = ManufacturerPart.objects.get_or_create(
                            part=part, manufacturer=company, MPN=mpn
                        )
                        for field in ("description", "link"):
                            value = mapped.get(f"manufacturer.{field}")
                            if value not in (None, "") or mode == "overwrite":
                                setattr(manufacturer_part, field, str(value or "").strip() or None)
                        manufacturer_part.full_clean()
                        manufacturer_part.save()
                        counts[f"manufacturer_{'created' if made else 'updated'}"] += 1
                    company_name = str(mapped.get("supplier.company") or "").strip()
                    sku = str(mapped.get("supplier.sku") or "").strip()
                    if company_name and sku:
                        company = Company.objects.get(name__iexact=company_name, is_supplier=True)
                        supplier_part, made = SupplierPart.objects.get_or_create(
                            part=part, supplier=company, SKU=sku,
                            defaults={"pack_quantity": "1"},
                        )
                        for field in ("description", "link", "packaging", "pack_quantity", "note"):
                            key = "notes" if field == "note" else field
                            value = mapped.get(f"supplier.{key}")
                            if value not in (None, "") or mode == "overwrite":
                                setattr(supplier_part, field, str(value or "").strip())
                        for field in ("active", "primary"):
                            key = f"supplier.{field}"
                            if key in mapped:
                                supplier_part_value = str(mapped[key]).strip().lower()
                                setattr(
                                    supplier_part, field,
                                    supplier_part_value in {"1", "true", "yes", "on"},
                                )
                        if manufacturer_part:
                            supplier_part.manufacturer_part = manufacturer_part
                        supplier_part.full_clean()
                        supplier_part.save()
                        counts[f"supplier_{'created' if made else 'updated'}"] += 1
                        raw_price = str(mapped.get("supplier.price") or "").strip()
                        if raw_price:
                            price_quantity = Decimal(
                                str(mapped.get("supplier.price_quantity") or "1").strip()
                            )
                            currency = str(
                                mapped.get("supplier.price_currency") or "USD"
                            ).strip().upper()
                            price_break, _made = SupplierPriceBreak.objects.update_or_create(
                                part=supplier_part,
                                quantity=price_quantity,
                                defaults={"price": Money(Decimal(raw_price), currency)},
                            )
                            price_break.full_clean()
                if any(counts.values()):
                    _mark_inventory_write(capture, "procurement")
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        except Exception:
            logger.exception("Procurement import failed for capture_id=%s", capture.pk)
            return Response({"detail": "Procurement import failed; the batch was rolled back."}, status=400)
        return Response({"capture_id": capture.pk, "mode": mode, **counts})


class CreateCaptureStockView(APIView):
    """Create stock only after an explicit opt-in, once per capture row."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True or request.data.get("enable_stock") is not True:
            return Response({"detail": "Set confirm and enable_stock to true."}, status=400)
        from decimal import Decimal, InvalidOperation
        from djmoney.money import Money
        from part.models import Part
        from stock.models import StockItem, StockLocation
        from users.permissions import check_user_permission
        if not check_user_permission(request.user, StockItem, "add"):
            return Response({"detail": "Stock Item add permission is required."}, status=403)
        capture = _capture_or_404(request, pk)
        created, skipped = [], []
        try:
            plan = _build_live_import_plan(_workflow_items(request, capture))
            if not plan["ready"] or plan["summary"]["create"]:
                return Response({"detail": "Create all Parts and resolve plan errors first.", "rows": plan["rows"]}, status=409)
            with transaction.atomic():
                for row in plan["rows"]:
                    mapped = row["mapped"]
                    raw_quantity = str(mapped.get("stock.quantity") or "").strip()
                    if not raw_quantity:
                        continue
                    if StockImportRecord.objects.filter(capture=capture, row_index=row["row_index"]).exists():
                        skipped.append({"row_index": row["row_index"], "reason": "already imported"})
                        continue
                    try:
                        quantity = Decimal(raw_quantity)
                    except InvalidOperation as exc:
                        raise ValueError(f"Row {row['row_index'] + 1}: invalid quantity.") from exc
                    if quantity <= 0:
                        raise ValueError(f"Row {row['row_index'] + 1}: quantity must be positive.")
                    part = _resolved_part(row, Part)
                    location = StockLocation.objects.get(name__iexact=str(mapped["stock.location"]).strip())
                    if location.structural:
                        raise ValueError(f"Row {row['row_index'] + 1}: location is structural.")
                    item = StockItem(
                        part=part, location=location, quantity=quantity,
                        batch=str(mapped.get("stock.batch") or "").strip(),
                        serial=str(mapped.get("stock.serial") or "").strip() or None,
                        link=str(mapped.get("stock.link") or "").strip() or None,
                        packaging=str(mapped.get("stock.packaging") or "").strip() or None,
                    )
                    if str(mapped.get("stock.status") or "").strip():
                        item.status = int(str(mapped["stock.status"]).strip())
                    if str(mapped.get("stock.purchase_price") or "").strip():
                        item.purchase_price = Money(
                            Decimal(str(mapped["stock.purchase_price"]).strip()),
                            str(mapped.get("stock.price_currency") or "USD").strip().upper(),
                        )
                    item.full_clean()
                    item.save(user=request.user, notes=str(mapped.get("stock.notes") or "").strip())
                    StockImportRecord.objects.create(
                        capture=capture, row_index=row["row_index"],
                        stock_item_id=item.pk, created_by=request.user,
                    )
                    created.append({"row_index": row["row_index"], "stock_item_id": item.pk, "quantity": str(quantity)})
                if created:
                    _mark_inventory_write(capture, "stock")
        except (ValueError, KeyError) as exc:
            return Response({"detail": str(exc)}, status=400)
        except Exception:
            logger.exception("Stock import failed for capture_id=%s", capture.pk)
            return Response({"detail": "Stock creation failed; the batch was rolled back."}, status=400)
        return Response({"capture_id": capture.pk, "created_count": len(created), "created": created,
                         "skipped_count": len(skipped), "skipped": skipped})
