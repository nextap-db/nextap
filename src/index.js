function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function rowToClient(row, origin) {
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    job_title: row.job_title || "",
    company: row.company || "",
    about: row.about || "",

    phone: row.phone || "",
    email: row.email || "",
    messenger: row.messenger || "",
    whatsapp: row.whatsapp || "",
    viber: row.viber || "",

    instagram: row.instagram || "",
    facebook: row.facebook || "",
    linkedin: row.linkedin || "",
    tiktok: row.tiktok || "",
    youtube: row.youtube || "",
    x: row.x || "",
    telegram: row.telegram || "",
    threads: row.threads || "",
    github: row.github || "",
    behance: row.behance || "",
    dribbble: row.dribbble || "",
    website: row.website || "",

    accent_color: row.accent_color || "#2162c6",

    active: Boolean(row.active),
    view_count: Number(row.view_count || 0),
    last_viewed_at: row.last_viewed_at || "",

    photo_url: row.photo_key || "",
    photo: row.photo_key || "",

    // Featured
    featured_enabled: Boolean(row.featured_enabled),
    featured_title: row.featured_title || "",
    featured_description: row.featured_description || "",
    featured_image: row.featured_image || "",
    featured_button_text: row.featured_button_text || "",
    featured_button_link: row.featured_button_link || "",

    // Quick Info
    location: row.location || "",
    business_hours: row.business_hours || "",
    services: row.services || "",
    portfolio: row.portfolio || "",
    booking: row.booking || "",
    reviews: row.reviews || "",
    payments: row.payments || "",

    quick_info_enabled: row.quick_info_enabled !== 0,

    show_location: row.show_location !== 0,
    show_business_hours: row.show_business_hours !== 0,
    show_services: row.show_services !== 0,
    show_portfolio: row.show_portfolio !== 0,
    show_booking: row.show_booking !== 0,
    show_reviews: row.show_reviews !== 0,
    show_payments: row.show_payments !== 0
  };
}

async function getClientByKey(env, key, origin) {
  const row = await env.DB.prepare(
    "SELECT * FROM clients WHERE id = ? OR slug = ? LIMIT 1"
  )
    .bind(key, key)
    .first();

  return rowToClient(row, origin);
}

async function handleApi(request, env, url) {
  const p = url.pathname;

  // GET ALL CLIENTS
  if (p === "/api/clients" && request.method === "GET") {
    const { results } = await env.DB
      .prepare("SELECT * FROM clients ORDER BY created_at DESC")
      .all();

    return json(results.map(r => rowToClient(r, url.origin)));
  }

  // GET ONE CLIENT
  if (p.startsWith("/api/clients/") && request.method === "GET") {
    const key = decodeURIComponent(p.split("/").pop());

    const client = await getClientByKey(env, key, url.origin);

    return client
      ? json(client)
      : json({ error: "Client profile not found" }, 404);
  }

  // CREATE / UPDATE CLIENT
  if (
    p === "/api/clients" &&
    (request.method === "POST" || request.method === "PUT")
  ) {
    const d = await request.json();

    const name = String(d.name || "").trim();

    if (!name) {
      return json({ error: "Name is required." }, 400);
    }

    const id = String(d.id || slugify(name));
    const slug = slugify(d.slug || name);

    if (!id || !slug) {
      return json({ error: "A valid name/slug is required." }, 400);
    }

    const existing = await env.DB
      .prepare(
        "SELECT photo_key, view_count, created_at, last_viewed_at FROM clients WHERE id = ? LIMIT 1"
      )
      .bind(id)
      .first();

    const photoKey = String(
      d.photo_key || existing?.photo_key || ""
    );

    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO clients
      (
        id,
        slug,
        name,
        job_title,
        company,
        about,
        phone,
        email,
        instagram,
        facebook,
        linkedin,
        tiktok,
        youtube,
        x,
        telegram,
        threads,
        github,
        behance,
        dribbble,
        messenger,
        whatsapp,
        viber,
        website,
        accent_color,
        photo_key,
        active,
        view_count,
        last_viewed_at,
        created_at,
        updated_at,

        featured_enabled,
        featured_title,
        featured_description,
        featured_image,
        featured_button_text,
        featured_button_link,

        location,
        business_hours,
        services,
        portfolio,
        booking,
        reviews,
        payments,

        quick_info_enabled,

        show_location,
        show_business_hours,
        show_services,
        show_portfolio,
        show_booking,
        show_reviews,
        show_payments
      )
      VALUES (
  ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
)
      ON CONFLICT(id) DO UPDATE SET

        slug=excluded.slug,
        name=excluded.name,
        job_title=excluded.job_title,
        company=excluded.company,
        about=excluded.about,

        phone=excluded.phone,
        email=excluded.email,
        instagram=excluded.instagram,
        facebook=excluded.facebook,
        linkedin=excluded.linkedin,
        tiktok=excluded.tiktok,
        youtube=excluded.youtube,
        x=excluded.x,
        telegram=excluded.telegram,
        threads=excluded.threads,
        github=excluded.github,
        behance=excluded.behance,
        dribbble=excluded.dribbble,
        messenger=excluded.messenger,
        whatsapp=excluded.whatsapp,
        viber=excluded.viber,
        website=excluded.website,

        accent_color=excluded.accent_color,
        photo_key=excluded.photo_key,
        active=excluded.active,

        featured_enabled=excluded.featured_enabled,
        featured_title=excluded.featured_title,
        featured_description=excluded.featured_description,
        featured_image=excluded.featured_image,
        featured_button_text=excluded.featured_button_text,
        featured_button_link=excluded.featured_button_link,

        location=excluded.location,
        business_hours=excluded.business_hours,
        services=excluded.services,
        portfolio=excluded.portfolio,
        booking=excluded.booking,
        reviews=excluded.reviews,
        payments=excluded.payments,

        quick_info_enabled=excluded.quick_info_enabled,

        show_location=excluded.show_location,
        show_business_hours=excluded.show_business_hours,
        show_services=excluded.show_services,
        show_portfolio=excluded.show_portfolio,
        show_booking=excluded.show_booking,
        show_reviews=excluded.show_reviews,
        show_payments=excluded.show_payments,

        updated_at=excluded.updated_at

    `).bind(

      id,
      slug,
      name,

      String(d.job_title || ""),
      String(d.company || ""),
      String(d.about || ""),

      String(d.phone || ""),
      String(d.email || ""),

      String(d.instagram || ""),
      String(d.facebook || ""),
      String(d.linkedin || ""),
      String(d.tiktok || ""),
      String(d.youtube || ""),
      String(d.x || ""),
      String(d.telegram || ""),
      String(d.threads || ""),
      String(d.github || ""),
      String(d.behance || ""),
      String(d.dribbble || ""),

      String(d.messenger || ""),
      String(d.whatsapp || ""),
      String(d.viber || ""),
      String(d.website || ""),

      String(d.accent_color || "#2162c6"),

      photoKey,

      d.active === false ? 0 : 1,

      Number(existing?.view_count || d.view_count || 0),

      String(existing?.last_viewed_at || ""),

      String(existing?.created_at || now),

      now,

      // Featured
      d.featured_enabled ? 1 : 0,
      String(d.featured_title || ""),
      String(d.featured_description || ""),
      String(d.featured_image || ""),
      String(d.featured_button_text || ""),
      String(d.featured_button_link || ""),

      // Quick Info
      String(d.location || ""),
      String(d.business_hours || ""),
      String(d.services || ""),
      String(d.portfolio || ""),
      String(d.booking || ""),
      String(d.reviews || ""),
      String(d.payments || ""),

      d.quick_info_enabled === false ? 0 : 1,

      d.show_location === false ? 0 : 1,
      d.show_business_hours === false ? 0 : 1,
      d.show_services === false ? 0 : 1,
      d.show_portfolio === false ? 0 : 1,
      d.show_booking === false ? 0 : 1,
      d.show_reviews === false ? 0 : 1,
      d.show_payments === false ? 0 : 1

    ).run();

    const saved = await getClientByKey(
      env,
      id,
      url.origin
    );

    return json(saved);
  }

  // PROFILE VIEW COUNTER
  if (
    p.startsWith("/api/clients/") &&
    request.method === "POST" &&
    p.endsWith("/view")
  ) {
    const id = decodeURIComponent(
      p.split("/")[3]
    );

    const existing = await env.DB
      .prepare(
        "SELECT id FROM clients WHERE id = ? OR slug = ? LIMIT 1"
      )
      .bind(id, id)
      .first();

    if (!existing) {
      return json({ error: "Profile not found" }, 404);
    }

    const now = new Date().toISOString();

    const result = await env.DB
      .prepare(
        "UPDATE clients SET view_count = COALESCE(view_count,0) + 1, last_viewed_at = ?, updated_at = ? WHERE id = ?"
      )
      .bind(
        now,
        now,
        existing.id
      )
      .run();

    const updated = await env.DB
      .prepare(
        "SELECT view_count FROM clients WHERE id = ?"
      )
      .bind(existing.id)
      .first();

    return json({
      ok: Boolean(result.success),
      views: Number(updated?.view_count || 0)
    });
  }

  // DELETE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "DELETE"
  ) {
    const id = decodeURIComponent(
      p.split("/").pop()
    );

    const existing = await env.DB
      .prepare(
        "SELECT id, photo_key FROM clients WHERE id = ? OR slug = ? LIMIT 1"
      )
      .bind(id, id)
      .first();

    if (!existing) {
      return json({ error: "Client not found" }, 404);
    }

    await env.DB
      .prepare(
        "DELETE FROM clients WHERE id = ?"
      )
      .bind(existing.id)
      .run();

    return json({ ok: true });
  }

  // PHOTO UPLOAD
  if (
    p === "/api/upload" &&
    request.method === "POST"
  ) {
    const form = await request.formData();
    const file = form.get("photo");

    if (!(file instanceof File)) {
      return json(
        { error: "No photo selected" },
        400
      );
    }

    if (!file.type.startsWith("image/")) {
      return json(
        { error: "Please choose an image file." },
        400
      );
    }

    if (file.size > 1200 * 1024) {
      return json(
        { error: "Photo must be 1.2 MB or smaller." },
        400
      );
    }

    const bytes = new Uint8Array(
      await file.arrayBuffer()
    );

    let binary = "";

    const chunk = 0x8000;

    for (
      let i = 0;
      i < bytes.length;
      i += chunk
    ) {
      binary += String.fromCharCode(
        ...bytes.subarray(i, i + chunk)
      );
    }

    const base64 = btoa(binary);

    const dataUrl =
      `data:${file.type};base64,${base64}`;

    return json({
      key: dataUrl,
      url: dataUrl
    });
  }

  return json(
    { error: "API route not found" },
    404
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {

      if (
        url.pathname.startsWith("/api/")
      ) {
        return await handleApi(
          request,
          env,
          url
        );
      }

      if (
        url.pathname === "/admin" ||
        url.pathname === "/admin/"
      ) {
        return env.ASSETS.fetch(
          new Request(
            new URL(
              "/admin/index.html",
              request.url
            ),
            request
          )
        );
      }

      if (
        url.pathname.startsWith("/profile/")
      ) {
        const slug =
          decodeURIComponent(
            url.pathname.slice(
              "/profile/".length
            )
          ).replace(
            /^\/+|\/+$/g,
            ""
          );

        if (!slug) {
          return Response.redirect(
            new URL(
              "/profile",
              request.url
            ),
            302
          );
        }

        const target =
          new URL(
            "/profile.html",
            request.url
          );

        target.searchParams.set(
          "slug",
          slug
        );

        return env.ASSETS.fetch(
          new Request(
            target.toString(),
            request
          )
        );
      }

      if (
        url.pathname === "/profile"
      ) {
        return env.ASSETS.fetch(
          new Request(
            new URL(
              "/profile.html",
              request.url
            ),
            request
          )
        );
      }

      return env.ASSETS.fetch(request);

    } catch (err) {

      return json(
        {
          error:
            err?.message ||
            "Server error"
        },
        500
      );
    }
  }
};
