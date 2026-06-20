package com.romp.ccremote.model;

/**
 * POJO matching a profile entry from the server's profile_list response.
 *
 * source: "native" (managed by CC Remote) or "cc-switch" (read-only, from CC Switch)
 * model: model name extracted from the profile's settings (e.g. "DeepSeek-V4-Pro"), nullable
 * isCurrent: true if this profile is currently active
 */
public class ProfileInfo {
    public String id;
    public String name;
    public String source = "native";
    public String model;
    public boolean isCurrent;

    public ProfileInfo() {}

    public ProfileInfo(String id, String name) {
        this.id = id;
        this.name = name;
    }

    public boolean isCCSwitch() {
        return "cc-switch".equals(source);
    }
}
