import { Link } from 'react-router-dom';
import './Home.css';

function Home() {
  return (
    <main className="home" lang="ar" dir="rtl">
      <nav className="home-nav" aria-label="التنقل الرئيسي">
        <Link className="home-brand" to="/" aria-label="الصفحة الرئيسية">
          <span className="home-brand-mark" aria-hidden="true">
            ط
          </span>
          <span>بوابة الطالب</span>
        </Link>

        <Link className="btn btn-secondary btn-sm" to="/login">
          تسجيل الدخول
        </Link>
      </nav>

      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-copy">
          <span className="home-eyebrow">مساحتك الجامعية</span>
          <h1 id="home-title">
            كل ما يحتاجه الطالب
            <span> في مكان واحد</span>
          </h1>
          <p>
            بوابة بسيطة تساعدك على الوصول إلى حسابك، ومراجعة بياناتك، وتحديث ملفك
            الشخصي بسهولة.
          </p>

          <div className="home-actions">
            <Link className="btn btn-primary" to="/login">
              الدخول إلى حسابي
            </Link>
            <Link className="btn btn-secondary" to="/register">
              إنشاء حساب جديد
            </Link>
          </div>
        </div>

        <div className="home-student-card card" aria-label="بطاقة الطالب">
          <span className="home-avatar" aria-hidden="true">
            أ
          </span>
          <div>
            <span className="home-card-label">ملف الطالب</span>
            <h2>مرحبًا بك</h2>
            <p>بياناتك الأكاديمية والشخصية متاحة لك في أي وقت.</p>
          </div>
          <span className="home-status">
            <span aria-hidden="true" /> جاهز
          </span>
        </div>
      </section>

      <footer className="home-footer">بوابة الطالب — تجربة بسيطة وآمنة</footer>
    </main>
  );
}

export default Home;
