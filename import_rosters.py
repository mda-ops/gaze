from app.connectors import RevenueCatcherJSONConnector
from app.database import load_chatter_lookup, load_creator_lookup, upsert_chatter_lookup, upsert_creator_lookup


creators = RevenueCatcherJSONConnector(
    r"C:\Users\HP\.codex\attachments\1a4307e3-0a9d-4777-ab33-b2926013b71b\pasted-text.txt"
).load()
chatters = RevenueCatcherJSONConnector(
    r"C:\Users\HP\.codex\attachments\9adcab8a-3b22-4f65-a99c-186e30f2d8da\pasted-text.txt"
).load()

creator_count = upsert_creator_lookup(creators)
chatter_count = upsert_chatter_lookup(chatters)

print(f"creators_saved={creator_count}")
print(f"chatters_saved={chatter_count}")
print(f"creator_table_rows={len(load_creator_lookup())}")
print(f"chatter_table_rows={len(load_chatter_lookup())}")
