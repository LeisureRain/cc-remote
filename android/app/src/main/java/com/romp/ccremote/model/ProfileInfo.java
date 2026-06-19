package com.romp.ccremote.model;

/**
 * POJO matching a profile entry from the server's profile_list response.
 */
public class ProfileInfo {
    public String id;
    public String name;

    public ProfileInfo() {}

    public ProfileInfo(String id, String name) {
        this.id = id;
        this.name = name;
    }
}
