import { describe, expect, it } from "vitest";
import { buildHubspotProperties, buildHubspotSearch, DEFAULT_HUBSPOT_MAPPING } from "./hubspot";

const CONTACT = {
  firstName: "María",
  lastName: "Pérez",
  email: "maria@example.com",
  phone: "+56987654321",
  country: "CL",
  source: "whatsapp",
};

describe("buildHubspotProperties", () => {
  it("mapea los campos por defecto y omite vacíos/nulos", () => {
    expect(buildHubspotProperties(CONTACT)).toEqual({
      firstname: "María",
      lastname: "Pérez",
      email: "maria@example.com",
      phone: "+56987654321",
    });
    expect(buildHubspotProperties({ firstName: "Ana", lastName: null, email: "  ", phone: undefined })).toEqual({ firstname: "Ana" });
  });

  it("respeta un fieldMapping personalizado del tenant", () => {
    const mapping = { ...DEFAULT_HUBSPOT_MAPPING, country: "country", lead_source: "source" };
    const props = buildHubspotProperties(CONTACT, mapping);
    expect(props.country).toBe("CL");
    expect(props.lead_source).toBe("whatsapp");
  });
});

describe("buildHubspotSearch (anti-duplicados)", () => {
  it("busca por teléfono Y por email como grupos OR", () => {
    const search = buildHubspotSearch(CONTACT);
    expect(search?.filterGroups).toHaveLength(2);
    expect(search?.filterGroups[0].filters[0]).toEqual({ propertyName: "phone", operator: "EQ", value: "+56987654321" });
    expect(search?.filterGroups[1].filters[0]).toEqual({ propertyName: "email", operator: "EQ", value: "maria@example.com" });
  });

  it("solo teléfono si no hay email; null si no hay nada que buscar", () => {
    expect(buildHubspotSearch({ phone: "+56911111111" })?.filterGroups).toHaveLength(1);
    expect(buildHubspotSearch({ firstName: "Sin datos" })).toBeNull();
  });
});
