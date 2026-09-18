-- วางโค้ดนี้ทั้งหมดใน Supabase: SQL Editor > New query > Run
-- สร้างตารางเก็บข้อมูลสมุดบัญชี (1 แถวต่อ 1 ผู้ใช้ เก็บทุกอย่างเป็น JSON ก้อนเดียว)

create table user_data (
  id uuid references auth.users(id) on delete cascade primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- เปิดระบบความปลอดภัยระดับแถว (Row Level Security)
alter table user_data enable row level security;

-- แต่ละคนอ่านได้เฉพาะแถวของตัวเอง
create policy "select_own"
  on user_data for select
  using (auth.uid() = id);

-- แต่ละคนสร้างได้เฉพาะแถวของตัวเอง
create policy "insert_own"
  on user_data for insert
  with check (auth.uid() = id);

-- แต่ละคนแก้ได้เฉพาะแถวของตัวเอง
create policy "update_own"
  on user_data for update
  using (auth.uid() = id);

-- เปิดใช้งาน Realtime สำหรับตารางนี้ (ให้ข้อมูลซิงค์สดข้ามอุปกรณ์)
alter publication supabase_realtime add table user_data;
