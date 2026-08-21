from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .common import _field_file_url, _thumbnail_url


class PartImageGalleryView(APIView):
    """Return primary and attached images for a Part gallery panel."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        from part.models import Part

        try:
            part = Part.objects.get(pk=pk)
        except Part.DoesNotExist:
            return Response(
                {"detail": "Part not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        images = []
        seen_urls = set()
        primary_url = _field_file_url(part.image)
        if primary_url:
            seen_urls.add(primary_url)
            images.append(
                {
                    "id": "primary",
                    "kind": "primary",
                    "url": primary_url,
                    "thumbnail_url": _thumbnail_url(part.image) or primary_url,
                    "filename": getattr(part.image, "name", "").rsplit("/", 1)[-1],
                    "comment": "Primary image",
                    "source_url": "",
                }
            )

        for attachment in part.attachments.all().order_by("pk"):
            is_image = getattr(attachment, "is_image", False)
            if callable(is_image):
                is_image = is_image()
            if not is_image:
                continue

            image_url = _field_file_url(attachment.attachment)
            if not image_url or image_url in seen_urls:
                continue
            seen_urls.add(image_url)

            comment = attachment.comment or ""
            source_url = ""
            prefix = "Imported product image: "
            if comment.startswith(prefix):
                source_url = comment[len(prefix) :].strip()

            images.append(
                {
                    "id": attachment.pk,
                    "kind": "attachment",
                    "url": image_url,
                    "thumbnail_url": (
                        _thumbnail_url(attachment) or image_url
                    ),
                    "filename": getattr(
                        attachment.attachment, "name", ""
                    ).rsplit("/", 1)[-1],
                    "comment": comment,
                    "source_url": source_url,
                }
            )

        return Response(
            {
                "part_id": part.pk,
                "part_name": part.name,
                "count": len(images),
                "images": images,
            }
        )
