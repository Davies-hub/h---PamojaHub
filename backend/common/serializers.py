"""Shared serializer mixins.

MediaURLRepresentationMixin — media columns (Campaign.banner_image_url,
Church.logo_url) store a bare OBJECT KEY for rows uploaded since 2026-07-18 and
an absolute URL for older rows (absolute forever — no backfill by design). The
wire contract is unchanged: both cases emit an absolute URL string under the
SAME field name, minted at serialization time by integrations.object_storage
.media_url(). A to_representation transform (not a SerializerMethodField) so no
field declaration changes — read_only_fields entries and declared fields stay
exactly as they are.
"""

from integrations.object_storage import media_url


class MediaURLRepresentationMixin:
    """Route the fields named in `media_url_fields` through media_url() on output.

    Output-only: deserialization/writes are untouched (all covered fields are
    server-set-only anyway). A field absent from the serialized dict (narrowed
    serializer) is skipped, never added.
    """

    media_url_fields = ()

    def to_representation(self, instance):
        data = super().to_representation(instance)
        for field in self.media_url_fields:
            if field in data:
                data[field] = media_url(data[field])
        return data
