from rest_framework import generics, permissions
from rest_framework.response import Response


class HealthView(generics.GenericAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return Response({"ok": True, "contract_version": "1.0"})
