# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in the SDK tools.

# Keep WebSocket and Gson
-keep class com.romp.ccremote.model.** { *; }
-keep class com.romp.ccremote.websocket.** { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
